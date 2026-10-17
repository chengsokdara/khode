package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Secrets live apart from config.json (auth.json, owner-only) so the
// config file itself stays shareable. Environment variables still win
// over anything stored here.

// Auth is the persisted secret store. APIKeys maps provider name to API
// key; a missing provider means no stored key.
type Auth struct {
	APIKeys map[string]string `json:"api_keys"`
}

// AuthPath returns the auth file path (~/.khode/auth.json).
func AuthPath() string { return filepath.Join(Dir(), "auth.json") }

// LoadAuth reads the auth file. A missing or unreadable file is not an
// error: khode runs without stored keys (env vars and the settings UI
// cover the rest), so only a parse failure is worth surfacing — and even
// that must not keep the app from starting.
func LoadAuth() *Auth {
	a := &Auth{}
	data, err := os.ReadFile(AuthPath())
	if err != nil {
		return a
	}
	if err := json.Unmarshal(data, a); err != nil {
		return &Auth{}
	}
	return a
}

// Key returns the stored key for provider ("" when none).
func (a *Auth) Key(provider string) string { return a.APIKeys[provider] }

// SetKey stores provider's key; an empty key deletes the entry, so the
// settings UI's "clear the field and press enter" removes it.
func (a *Auth) SetKey(provider, key string) {
	if key == "" {
		delete(a.APIKeys, provider)
		return
	}
	if a.APIKeys == nil {
		a.APIKeys = map[string]string{}
	}
	a.APIKeys[provider] = key
}

// Save writes the auth file with owner-only permissions, atomically: a
// crash mid-write must never leave a truncated secrets file behind.
func (a *Auth) Save() error {
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	path := AuthPath()
	tmp := path + ".tmp"
	if err := writeFileSync(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// writeFileSync writes data to path and fsyncs before returning, so the
// rename that follows in Save can never expose unwritten bytes.
func writeFileSync(path string, data []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(path)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return err
	}
	return nil
}
