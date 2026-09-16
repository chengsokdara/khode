// Package config loads and persists khode's user-level configuration
// (~/.khode/config.json).
package config

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
)

// Defaults used when no config file exists (or fields are missing).
const (
	DefaultModel     = "claude-sonnet-4-5"
	DefaultMaxTokens = 8192
)

// Config is the persisted user configuration.
type Config struct {
	Model     string `json:"model"`
	MaxTokens int    `json:"max_tokens"`
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

// Load reads the config file, applying defaults for missing values.
// A missing file is not an error; defaults are returned instead.
func Load() (*Config, error) {
	cfg := &Config{Model: DefaultModel, MaxTokens: DefaultMaxTokens}

	data, err := os.ReadFile(Path())
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return cfg, nil
		}
		return nil, err
	}
	if err := json.Unmarshal(data, cfg); err != nil {
		return nil, err
	}
	if cfg.Model == "" {
		cfg.Model = DefaultModel
	}
	if cfg.MaxTokens <= 0 {
		cfg.MaxTokens = DefaultMaxTokens
	}
	return cfg, nil
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
