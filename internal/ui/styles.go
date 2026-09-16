package ui

import "github.com/charmbracelet/lipgloss"

// Central palette so colors stay consistent across all views.
var (
	headerStyle   = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("212"))
	titleStyle    = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("212")).Padding(0, 1)
	dimStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("241"))
	userStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("39"))
	systemStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("241")).Italic(true)
	errorStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("203")).Bold(true)
	statusStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("212"))
	okStyle       = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	inputBorder   = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(lipgloss.Color("240"))
	viewportStyle = lipgloss.NewStyle().Padding(0, 1)
)
