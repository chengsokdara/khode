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

// CustomProvider is a user-defined provider that speaks one of the
// built-in wire protocols against a different endpoint — Ollama, LM
// Studio, OpenRouter, a proxy. Kind selects the protocol ("openai" or
// "anthropic"); BaseURL is the endpoint root, shaped the way that
// protocol's SDK expects (OpenAI-style URLs include /v1).
type CustomProvider struct {
	Kind    string `json:"kind"`
	BaseURL string `json:"base_url"`
}

// IsBuiltinProvider reports whether name is one of the built-in
// providers rather than a user-defined one. Letter casing is ignored,
// so "OpenAI" in a hand-edited config is still the built-in.
func IsBuiltinProvider(name string) bool {
	return strings.EqualFold(name, "anthropic") || strings.EqualFold(name, "openai") ||
		strings.EqualFold(name, "khateway")
}

// ManagedEndpoint reports whether provider's endpoint is fixed by khode
// and therefore not editable in the TUI: the provider row only selects
// it, the base-url row is read-only, and pointing it somewhere else is
// an environment concern (KHATEWAY_BASE_URL). khateway is khode-native —
// its identity must not be repointed at an arbitrary origin by accident.
func ManagedEndpoint(name string) bool {
	return strings.EqualFold(name, "khateway")
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
	// CustomProviders defines extra providers on top of the built-ins,
	// keyed by name. Each speaks a built-in protocol against its own
	// endpoint; keys live in auth.json under the same name.
	CustomProviders map[string]CustomProvider `json:"custom_providers,omitempty"`
	// ModelChoices caches each provider's known models — fetched from
	// its endpoint or added manually — so the settings UI can offer a
	// picker. The first entry is a fallback when Models has no choice.
	ModelChoices map[string][]string `json:"model_choices,omitempty"`
	// MCPServers names the MCP server processes to start with the app.
	MCPServers map[string]MCPServer `json:"mcp_servers,omitempty"`
	// Hooks run shell commands on agent lifecycle events.
	Hooks Hooks `json:"hooks,omitempty"`
	// GatherContext turns the automatic first-prompt context gatherer
	// off (false) or explicitly on (true); nil means enabled. The
	// gatherer is read-only, so this only trades one model call for a
	// better-grounded first turn.
	GatherContext *bool `json:"gather_context,omitempty"`
	// SubagentModel overrides the model that task subagents and the
	// context gatherer run on (a faster/cheaper one fits their narrow
	// jobs). Empty means the main model.
	SubagentModel string `json:"subagent_model,omitempty"`
	// Icons selects the glyph pack the UI draws its marks from: "auto"
	// (safe Unicode symbols), "nerd" (Nerd Font icons, needs a patched
	// terminal font), or "ascii" (plain text for dumb terminals).
	// Empty means auto.
	Icons string `json:"icons,omitempty"`

	// override is the session-scoped --model flag value; never persisted.
	override string
}

// GatherOn reports whether the automatic first-prompt context gatherer
// is enabled; absent from the file means enabled.
func (c *Config) GatherOn() bool { return c.GatherContext == nil || *c.GatherContext }

// SetGatherContext persists the gatherer toggle.
func (c *Config) SetGatherContext(on bool) { c.GatherContext = &on }

// SubModel returns the subagent model override, "" when subagents
// should ride the main model.
func (c *Config) SubModel() string { return strings.TrimSpace(c.SubagentModel) }

// SetSubagentModel persists the subagent model override; empty clears it.
func (c *Config) SetSubagentModel(name string) { c.SubagentModel = strings.TrimSpace(name) }

// Icon-set values accepted by SetIcons; IconAuto is the default.
const (
	IconAuto  = "auto"
	IconNerd  = "nerd"
	IconASCII = "ascii"
)

// IconSet returns the configured glyph pack, "auto" when unset.
func (c *Config) IconSet() string {
	switch strings.TrimSpace(c.Icons) {
	case IconNerd, IconASCII:
		return strings.TrimSpace(c.Icons)
	}
	return IconAuto
}

// SetIcons persists the glyph pack choice; anything but nerd/ascii
// snaps back to auto so a hand-edited value can't wedge the UI.
func (c *Config) SetIcons(set string) {
	if set != IconNerd && set != IconASCII {
		set = IconAuto
	}
	c.Icons = set
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

// AgentsDir returns the directory holding user-defined subagent kinds
// (one markdown file per kind); it may not exist.
func AgentsDir() string { return filepath.Join(Dir(), "agents") }

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

// Model returns the model for the active provider: the --model override
// if set, else the provider's last-used model, else the first cached
// choice, else the provider's default. Custom providers and khateway
// have no built-in default — an unset model comes back empty so the UI
// can ask for one instead of calling the endpoint with a made-up name.
func (c *Config) Model() string {
	if c.override != "" {
		return c.override
	}
	if k, ok := providerKey(c.Models, c.Provider); ok && c.Models[k] != "" {
		return c.Models[k]
	}
	if k, ok := providerKey(c.ModelChoices, c.Provider); ok {
		if choices := c.ModelChoices[k]; len(choices) > 0 && choices[0] != "" {
			return choices[0]
		}
	}
	if _, ok := providerKey(c.CustomProviders, c.Provider); ok {
		return ""
	}
	// khateway only serves models its admin configured, so a vendor
	// default would be a made-up request; the picker fetches the real
	// list instead.
	if strings.EqualFold(c.Provider, "khateway") {
		return ""
	}
	if m := defaultModels[c.Provider]; m != "" {
		return m
	}
	return DefaultModel
}

// SetModel records name as the active provider's model (persisted by the
// next Save) and clears any session-scoped override. The model joins the
// provider's cached choices, so manual entries show up in the picker.
func (c *Config) SetModel(name string) {
	if c.Models == nil {
		c.Models = map[string]string{}
	}
	c.Models[c.Provider] = name
	c.AddModelChoice(c.Provider, name)
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
	Provider        string                    `json:"provider"`
	Models          map[string]string         `json:"models"`
	MaxTokens       int                       `json:"max_tokens"`
	PermissionMode  string                    `json:"permission_mode"`
	BaseURLs        map[string]string         `json:"base_urls"`
	CustomProviders map[string]CustomProvider `json:"custom_providers"`
	ModelChoices    map[string][]string       `json:"model_choices"`
	MCPServers      map[string]MCPServer      `json:"mcp_servers"`
	Hooks           Hooks                     `json:"hooks"`
	GatherContext   *bool                     `json:"gather_context"`
	SubagentModel   string                    `json:"subagent_model"`
	Icons           string                    `json:"icons"`
	Model           string                    `json:"model"` // legacy single-model schema
}

// apply converts a parsed config file into a validated Config, filling
// defaults and seeding Models from the legacy field.
func (r rawConfig) apply() *Config {
	cfg := defaults()
	// The provider name is kept exactly as saved: custom-provider,
	// models, and model-choice map keys all carry the casing the UI
	// wrote, and lookups re-match it case-insensitively if it drifts.
	// (Lowercasing here once split the name from those keys, so a
	// provider named "KiosAPI" came back as the unknown protocol
	// "kiosapi".)
	if p := strings.TrimSpace(r.Provider); p != "" {
		cfg.Provider = p
	}
	if r.MaxTokens > 0 {
		cfg.MaxTokens = r.MaxTokens
	}
	// Unknown modes degrade to the safe default instead of erroring.
	cfg.PermissionMode = string(perm.Parse(r.PermissionMode))
	if r.GatherContext != nil {
		cfg.GatherContext = r.GatherContext
	}
	cfg.SubagentModel = strings.TrimSpace(r.SubagentModel)
	cfg.Icons = r.Icons
	if len(r.CustomProviders) > 0 {
		cfg.CustomProviders = r.CustomProviders
		// Snap the active name to the stored key's casing so it lines
		// up with the maps the UI wrote under that name.
		if !IsBuiltinProvider(cfg.Provider) {
			if k, ok := providerKey(cfg.CustomProviders, cfg.Provider); ok {
				cfg.Provider = k
			}
		}
	}
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
	if len(r.ModelChoices) > 0 {
		cfg.ModelChoices = r.ModelChoices
	}
	cfg.Hooks = r.Hooks
	return cfg
}
