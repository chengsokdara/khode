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
	"khode/internal/ui"

	tea "github.com/charmbracelet/bubbletea"
)

func main() {
	resume := flag.Bool("resume", false, "resume the most recent session")
	model := flag.String("model", "", "model override, e.g. claude-sonnet-4-5")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("khode", ui.Version)
		return
	}

	if os.Getenv("ANTHROPIC_API_KEY") == "" {
		fmt.Fprintln(os.Stderr, "khode: ANTHROPIC_API_KEY is not set")
		fmt.Fprintln(os.Stderr, "export ANTHROPIC_API_KEY=sk-ant-... and try again")
		os.Exit(1)
	}

	cfg, err := config.Load()
	if err != nil {
		fatal(err)
	}
	if *model != "" {
		cfg.Model = *model
	}

	var sess *agent.Session
	if *resume {
		sess, err = agent.LoadLatest(config.SessionsDir())
		if errors.Is(err, agent.ErrNoSessions) {
			fmt.Fprintln(os.Stderr, "khode: no previous sessions to resume")
			os.Exit(1)
		}
	} else {
		sess, err = agent.NewSession(config.SessionsDir())
	}
	if err != nil {
		fatal(err)
	}

	provider := llm.NewAnthropic()
	m := ui.New(cfg, provider, sess)

	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fatal(err)
	}
}

func fatal(err error) {
	fmt.Fprintf(os.Stderr, "khode: %v\n", err)
	os.Exit(1)
}
