// Command khode is a terminal-native coding assistant (Claude Code style).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"os"
	"sort"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/debug"
	"khode/internal/llm"
	"khode/internal/mcp"
	"khode/internal/tools"
	"khode/internal/ui"

	tea "charm.land/bubbletea/v2"
)

// sortedServerNames lists MCP server names in order, so startup output
// and registration are deterministic.
func sortedServerNames(servers map[string]config.MCPServer) []string {
	names := make([]string, 0, len(servers))
	for n := range servers {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// resumeFlag implements the tri-state --resume flag: bare --resume (the
// flag package passes "true") opens the session picker; --resume=<name>
// resumes a session by exact name or unique prefix.
type resumeFlag string

func (r *resumeFlag) String() string     { return string(*r) }
func (r *resumeFlag) Set(s string) error { *r = resumeFlag(s); return nil }

func main() {
	resume := resumeFlag("")
	cont := flag.Bool("continue", false, "continue the most recent session")
	flag.Var(&resume, "resume", "open the session picker, or resume one: --resume=<name>")
	providerName := flag.String("provider", "", "provider override: anthropic, openai, khateway (default from config)")
	model := flag.String("model", "", "model override, e.g. claude-sonnet-4-5")
	debugFlag := flag.Bool("debug", false, "log development debug output to khode-debug.log")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("khode", ui.Version)
		return
	}

	if *debugFlag {
		// The log file, not stderr: anything written to the terminal
		// mid-frame would corrupt the TUI's alternate screen. Point the
		// standard logger there, then internal/debug.Printf works
		// anywhere in the codebase.
		f, err := tea.LogToFile("khode-debug.log", "khode ")
		if err != nil {
			fatal(err)
		}
		defer f.Close()
		debug.Enable()
		fmt.Fprintln(os.Stderr, "khode: debugging on — tail khode-debug.log (details survive the TUI)")
	}

	cfg, err := config.Load()
	if err != nil {
		fatal(err)
	}
	if *model != "" {
		cfg.SetModelOverride(*model)
	}

	// No key is required to launch: credentials come from the
	// environment when set, otherwise from ~/.khode/auth.json (saved by
	// the settings UI). With neither, khode still starts — the welcome
	// walkthrough opens so the key can be pasted in, and a turn without
	// one fails with a pointer there instead of a raw 401. Custom
	// providers ride the built-in protocols under their own name.
	name := *providerName
	if name == "" {
		name = cfg.Provider
	}
	auth := config.LoadAuth()
	key, baseURL := cfg.Credentials(auth, name)
	provider, err := llm.NewProtocol(cfg.ProviderProtocol(name), name, key, baseURL)
	if err != nil {
		// A bad provider entry (e.g. a hand-edited custom kind) must
		// not keep khode from starting: warn, ride the default
		// protocol, and let /settings → provider fix the entry.
		fmt.Fprintf(os.Stderr, "khode: %v — starting with the anthropic provider; fix it under /settings → provider\n", err)
		provider, err = llm.New(llm.ProviderAnthropic, "", "")
		if err != nil {
			fatal(err)
		}
	}

	noSessions := func() {
		fmt.Fprintln(os.Stderr, "khode: no previous sessions to resume")
		os.Exit(1)
	}

	var pickerEntries []agent.Info
	var sess *agent.Session
	switch {
	case resume == "true": // bare --resume: pick interactively
		var err error
		pickerEntries, err = agent.LoadSessions(config.SessionsDir())
		if errors.Is(err, agent.ErrNoSessions) {
			noSessions()
		}
		if err != nil {
			fatal(err)
		}
		// Scratch transcript behind the picker; abandoned empties are
		// filtered out of listings.
		sess, err = agent.NewSession(config.SessionsDir())
		if err != nil {
			fatal(err)
		}
	case resume != "": // --resume=<name>
		var err error
		sess, err = agent.LoadByName(config.SessionsDir(), string(resume))
		if errors.Is(err, agent.ErrNoSessions) {
			noSessions()
		}
		if err != nil {
			fatal(err)
		}
	case *cont:
		var err error
		sess, err = agent.LoadLatest(config.SessionsDir())
		if errors.Is(err, agent.ErrNoSessions) {
			noSessions()
		}
		if err != nil {
			fatal(err)
		}
	default:
		var err error
		sess, err = agent.NewSession(config.SessionsDir())
		if err != nil {
			fatal(err)
		}
	}

	// Tools resolve the model's relative paths against the working
	// directory khode was launched from.
	workdir, err := os.Getwd()
	if err != nil {
		fatal(err)
	}
	registry := tools.Default(workdir)

	// MCP servers from config: start each one and register its tools. A
	// server that fails warns but never keeps the app from starting.
	// The running set is handed to the UI so /settings can start and
	// stop servers live.
	mcpClients := map[string]*mcp.Client{}
	for _, name := range sortedServerNames(cfg.MCPServers) {
		sc := cfg.MCPServers[name]
		ctx, cancel := context.WithTimeout(context.Background(), mcp.InitTimeout)
		cli, err := mcp.Start(ctx, name, sc.Command, sc.Args, sc.Env)
		cancel()
		if err != nil {
			fmt.Fprintf(os.Stderr, "khode: mcp server %q unavailable: %v\n", name, err)
			continue
		}
		defer cli.Close()
		mcpClients[name] = cli
		if err := tools.AddMCP(registry, name, cli, sc.Risk); err != nil {
			fmt.Fprintf(os.Stderr, "khode: mcp server %q has no tools: %v\n", name, err)
			continue
		}
	}

	m := ui.New(cfg, auth, provider, sess, registry, mcpClients, workdir)
	if pickerEntries != nil {
		m.OpenPicker(pickerEntries)
	} else if key == "" && len(cfg.CustomProviders) == 0 && len(cfg.ModelChoices) == 0 {
		// First run — no credentials, no custom provider, no model ever
		// chosen — walks through setup. A keyless setup (Ollama) or an
		// env-var user must not see it again; esc skips it regardless,
		// and khode stays usable either way.
		m.OpenWelcome()
	}

	// Alt screen and mouse capture are declared on the model's View
	// (tea.View fields) in v2: the app owns the whole window and the
	// terminal's scrollback is suspended, so pgup/pgdn and the captured
	// wheel scroll the chat, while shift+drag still selects text
	// terminal-side.
	p := tea.NewProgram(m)
	if _, err := p.Run(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "khode: %v\n", err)
	os.Exit(1)
}
