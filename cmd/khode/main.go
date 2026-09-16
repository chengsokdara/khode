// Command khode is a terminal-native coding assistant (Claude Code style).
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/llm"
	"khode/internal/tools"
	"khode/internal/ui"

	tea "github.com/charmbracelet/bubbletea"
)

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
	providerName := flag.String("provider", "", "provider override: anthropic or openai (default from config)")
	model := flag.String("model", "", "model override, e.g. claude-sonnet-4-5")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("khode", ui.Version)
		return
	}

	cfg, err := config.Load()
	if err != nil {
		fatal(err)
	}
	if *model != "" {
		cfg.SetModelOverride(*model)
	}

	name := *providerName
	if name == "" {
		name = cfg.Provider
	}
	var provider llm.Provider
	switch name {
	case "anthropic":
		if os.Getenv("ANTHROPIC_API_KEY") == "" {
			fmt.Fprintln(os.Stderr, "khode: ANTHROPIC_API_KEY is not set")
			fmt.Fprintln(os.Stderr, "export ANTHROPIC_API_KEY=sk-ant-... and try again")
			os.Exit(1)
		}
		provider = llm.NewAnthropic()
	case "openai":
		if os.Getenv("OPENAI_API_KEY") == "" {
			fmt.Fprintln(os.Stderr, "khode: OPENAI_API_KEY is not set")
			fmt.Fprintln(os.Stderr, "export OPENAI_API_KEY=sk-... and try again")
			os.Exit(1)
		}
		provider = llm.NewOpenAI()
	default:
		fmt.Fprintf(os.Stderr, "khode: unknown provider %q (want anthropic or openai)\n", name)
		os.Exit(1)
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

	m := ui.New(cfg, provider, sess, registry, workdir)
	if pickerEntries != nil {
		m.OpenPicker(pickerEntries)
	}

	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "khode: %v\n", err)
	os.Exit(1)
}
