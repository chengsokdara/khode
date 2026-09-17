// Package config loads and persists khode's user-level configuration
// (~/.khode/config.json).
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"khode/internal/perm"
)

// Defaults used when no config file exists (or fields are missing).
const (
	DefaultProvider  = "anthropic"
	DefaultModel     = "claude-sonnet-4-5"
	DefaultMaxTokens = 8192
)

// defaultModels holds each provider's built-in fallback model, used when
// the user has not chosen a model for that provider (no entry in Models).
var defaultModels = map[string]string{
	"anthropic": DefaultModel,
	"openai":    "gpt-5-mini",
}

// MCPServer is one configured Model Context Protocol server process.
type MCPServer struct {
	Command string   `json:"command"`
	Args    []string `json:"args,omitempty"`
	// Env entries (KEY=VALUE) are added over the inherited environment.
	Env []string `json:"env,omitempty"`
	// Risk overrides the permission class of this server's tools (read,
	// write, exec). Empty means exec: an MCP tool can do anything, so it
	// must be approved like a shell command by default.
	Risk string `json:"risk,omitempty"`
}

// Hook is one user command run on an agent lifecycle event. Tools limits
// it to those tool names; empty means every tool call.
type Hook struct {
	Command string   `json:"command"`
	Tools   []string `json:"tools,omitempty"`
}

// Hooks are the user's agent lifecycle hooks. PreTool runs before each
// tool call and can block it (exit code 2); PostTool runs after and is
// informational only.
type Hooks struct {
	PreTool  []Hook `json:"pre_tool,omitempty"`
	PostTool []Hook `json:"post_tool,omitempty"`
}

// Config is the persisted user configuration. The active model is looked
// up through Model; per-provider last-used models live in Models.
type Config struct {
	Provider  string            `json:"provider"`
	Models    map[string]string `json:"models,omitempty"`
	MaxTokens int               `json:"max_tokens"`
	// PermissionMode is one of the perm.Mode values; how much the agent
	// may do without asking.
	PermissionMode string `json:"permission_mode,omitempty"`
	// BaseURLs overrides each provider's API endpoint (proxies,
	// OpenAI-compatible local gateways). Empty means the SDK default, or
	// its *_BASE_URL environment variable when that is set.
	BaseURLs map[string]string `json:"base_urls,omitempty"`
	// MCPServers names the MCP server processes to start with the app.
	MCPServers map[string]MCPServer `json:"mcp_servers,omitempty"`
	// Hooks run shell commands on agent lifecycle events.
	Hooks Hooks `json:"hooks,omitempty"`

	// override is the session-scoped --model flag value; never persisted.
	override string
}

// Dir returns khode's state directory (~/.khode).
func Dir() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".khode"
	}
	return filepath.Join(home, ".khode")
}

// SessionsDir returns the directory holding session transcripts.
func SessionsDir() string { return filepath.Join(Dir(), "sessions") }

// Path returns the config file path.
func Path() string { return filepath.Join(Dir(), "config.json") }

// Load reads the config file, applying defaults for missing values and
// migrating the legacy single-"model" schema. A missing file is not an
// error; defaults are returned instead.
func Load() (*Config, error) {
	data, err := os.ReadFile(Path())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return defaults(), nil
		}
		return nil, fmt.Errorf("reading config: %w", err)
	}
	var raw rawConfig
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}
	return raw.apply(), nil
}

// Save writes the config back to disk.
func (c *Config) Save() error {
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(Path(), append(data, '\n'), 0o644)
}

// Model returns the model for the active provider: the --model override if
// set, else the provider's last-used model, else the provider's built-in
// default.
func (c *Config) Model() string {
	if c.override != "" {
		return c.override
	}
	if m := c.Models[c.Provider]; m != "" {
		return m
	}
	if m := defaultModels[c.Provider]; m != "" {
		return m
	}
	return DefaultModel
}

// SetModel records name as the active provider's model (persisted by the
// next Save) and clears any session-scoped override.
func (c *Config) SetModel(name string) {
	if c.Models == nil {
		c.Models = map[string]string{}
	}
	c.Models[c.Provider] = name
	c.override = ""
}

// SetModelOverride applies a session-scoped model that wins over Models
// until SetModel is called; it is never persisted.
func (c *Config) SetModelOverride(name string) { c.override = name }

// BaseURL returns the stored endpoint override for provider ("" when
// none). The llm package layers the *_BASE_URL env vars on top of this.
func (c *Config) BaseURL(provider string) string { return c.BaseURLs[provider] }

func defaults() *Config {
	return &Config{
		Provider:       DefaultProvider,
		MaxTokens:      DefaultMaxTokens,
		PermissionMode: string(perm.DefaultMode),
	}
}

// rawConfig mirrors the config file schema, including the pre-provider
// single "model" field so old files migrate cleanly.
type rawConfig struct {
	Provider       string               `json:"provider"`
	Models         map[string]string    `json:"models"`
	MaxTokens      int                  `json:"max_tokens"`
	PermissionMode string               `json:"permission_mode"`
	BaseURLs       map[string]string    `json:"base_urls"`
	MCPServers     map[string]MCPServer `json:"mcp_servers"`
	Hooks          Hooks                `json:"hooks"`
	Model          string               `json:"model"` // legacy single-model schema
}

// apply converts a parsed config file into a validated Config, filling
// defaults and seeding Models from the legacy field.
func (r rawConfig) apply() *Config {
	cfg := defaults()
	if p := strings.ToLower(strings.TrimSpace(r.Provider)); p != "" {
		cfg.Provider = p
	}
	if r.MaxTokens > 0 {
		cfg.MaxTokens = r.MaxTokens
	}
	// Unknown modes degrade to the safe default instead of erroring.
	cfg.PermissionMode = string(perm.Parse(r.PermissionMode))
	if len(r.Models) > 0 {
		cfg.Models = r.Models
	}
	if cfg.Models == nil {
		cfg.Models = map[string]string{}
	}
	if cfg.Models[cfg.Provider] == "" && r.Model != "" {
		cfg.Models[cfg.Provider] = r.Model
	}
	if len(r.MCPServers) > 0 {
		cfg.MCPServers = r.MCPServers
	}
	if len(r.BaseURLs) > 0 {
		cfg.BaseURLs = r.BaseURLs
	}
	cfg.Hooks = r.Hooks
	return cfg
}
