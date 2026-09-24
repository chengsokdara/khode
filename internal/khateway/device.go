// Package khateway implements khode's device-flow sign-in against a
// Khateway gateway (RFC 8628 shaped): the client mints a sign-in request,
// the user approves it in the portal (the session cookie there is the
// authority), and the next poll returns a PERSONAL API key for the
// approving account. Endpoints: POST /api/v1/device/code and
// POST /api/v1/device/token; the human step is GET /app/device.
package khateway

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// DefaultBaseURL mirrors llm.DefaultKhatewayEndpoint (duplicated, not
// imported, so this package stays a standalone HTTP client).
const DefaultBaseURL = "http://localhost:8787/v1"

// Poll bounds: khode polls at the interval the mint response names
// (khateway says 5s); every HTTP call is individually bounded.
const (
	startTimeout = 15 * time.Second
	pollTimeout  = 15 * time.Second
)

// Code is a minted sign-in request: show UserCode (or open
// VerificationURIComplete) and poll DeviceCode until approved.
type Code struct {
	DeviceCode              string
	UserCode                string
	VerificationURI         string
	VerificationURIComplete string
	ExpiresIn               int
	Interval                int
}

// Result is a granted sign-in: a personal API key (shown once) plus the
// account it belongs to, for the confirmation line in the TUI.
type Result struct {
	AccessToken string
	KeyName     string
	Email       string
	BalanceUSD  float64
}

// Sentinel poll outcomes the caller distinguishes: keep waiting, stop.
var (
	ErrPending = errors.New("authorization pending")
	ErrDenied  = errors.New("sign-in was denied in the browser")
	ErrExpired = errors.New("sign-in request expired or was already used")
)

// origin normalizes any khateway base spelling — the openai face (…/v1),
// the anthropic face (…/v1/messages), a bare origin — into the gateway
// origin where /api/v1/device lives.
func origin(baseURL string) string {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultBaseURL
	}
	b := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	b = strings.TrimSuffix(b, "/v1/messages")
	b = strings.TrimSuffix(b, "/v1")
	return b
}

type httpClient interface {
	Do(req *http.Request) (*http.Response, error)
}

func postJSON(ctx context.Context, client httpClient, url string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encoding request: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("building request: %w", err)
	}
	req.Header.Set("content-type", "application/json")
	if client == nil {
		client = &http.Client{Timeout: startTimeout}
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("calling khateway: %w", err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return nil, fmt.Errorf("reading khateway response: %w", err)
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return data, fmt.Errorf("khateway returned %s: %s", res.Status, strings.TrimSpace(string(data)))
	}
	return data, nil
}

// Start mints a sign-in request. deviceName (e.g. "khode on mbp") is shown
// to the approver and becomes the issued key's name.
func Start(ctx context.Context, client httpClient, baseURL, deviceName string) (Code, error) {
	ctx, cancel := context.WithTimeout(ctx, startTimeout)
	defer cancel()
	data, err := postJSON(ctx, client, origin(baseURL)+"/api/v1/device/code", map[string]string{"display_name": deviceName})
	if err != nil {
		return Code{}, err
	}
	var wire struct {
		DeviceCode              string `json:"device_code"`
		UserCode                string `json:"user_code"`
		VerificationURI         string `json:"verification_uri"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresIn               int    `json:"expires_in"`
		Interval                int    `json:"interval"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return Code{}, fmt.Errorf("parsing device code response: %w", err)
	}
	if wire.DeviceCode == "" || wire.UserCode == "" {
		return Code{}, fmt.Errorf("khateway device response missing codes")
	}
	return Code{
		DeviceCode:              wire.DeviceCode,
		UserCode:                wire.UserCode,
		VerificationURI:         wire.VerificationURI,
		VerificationURIComplete: wire.VerificationURIComplete,
		ExpiresIn:               wire.ExpiresIn,
		Interval:                wire.Interval,
	}, nil
}

// Poll asks once whether the request was approved. ErrPending means "not
// yet — keep polling at Code.Interval"; ErrDenied/ErrExpired mean stop;
// a non-nil Result carries the granted key.
func Poll(ctx context.Context, client httpClient, baseURL, deviceCode string) (Result, error) {
	ctx, cancel := context.WithTimeout(ctx, pollTimeout)
	defer cancel()
	data, err := postJSON(ctx, client, origin(baseURL)+"/api/v1/device/token", map[string]string{"device_code": deviceCode})
	if err != nil {
		// postJSON folds non-2xx bodies into the error text; decode the
		// RFC error vocabulary out of it for the sentinel outcomes.
		var wire struct {
			Error string `json:"error"`
		}
		if jerr := json.Unmarshal(data, &wire); jerr == nil {
			switch wire.Error {
			case "authorization_pending":
				return Result{}, ErrPending
			case "access_denied":
				return Result{}, ErrDenied
			case "expired_token":
				return Result{}, ErrExpired
			}
		}
		return Result{}, err
	}
	var wire struct {
		AccessToken string `json:"access_token"`
		Key         struct {
			Name string `json:"name"`
		} `json:"key"`
		User struct {
			Email      string  `json:"email"`
			BalanceUSD float64 `json:"balance_usd"`
		} `json:"user"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return Result{}, fmt.Errorf("parsing token response: %w", err)
	}
	if wire.AccessToken == "" {
		return Result{}, fmt.Errorf("khateway token response missing access_token")
	}
	return Result{AccessToken: wire.AccessToken, KeyName: wire.Key.Name, Email: wire.User.Email, BalanceUSD: wire.User.BalanceUSD}, nil
}
