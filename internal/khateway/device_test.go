package khateway

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

// fakeGateway speaks the khateway device contract: /api/v1/device/code mints
// (echoing a caller-chosen user code), /api/v1/device/token replays a
// scripted sequence of outcomes.
func fakeGateway(t *testing.T, outcomes *atomic.Int32) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/device/code", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DisplayName string `json:"display_name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.DisplayName == "" {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"display_name required"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"device_code":"devcode123","user_code":"ABCD-EFGH","verification_uri":"` + "http://x/app/device" + `","verification_uri_complete":"http://x/app/device?code=ABCD-EFGH","expires_in":600,"interval":5}`))
	})
	mux.HandleFunc("POST /api/v1/device/token", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			DeviceCode string `json:"device_code"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.DeviceCode != "devcode123" {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"expired_token","error_description":"unknown"}`))
			return
		}
		n := outcomes.Add(1)
		w.Header().Set("Content-Type", "application/json")
		switch n {
		case 1:
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"authorization_pending","error_description":"wait"}`))
		case 2:
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"error":"slow_down","error_description":"slow"}`))
		default:
			w.Write([]byte(`{"access_token":"khat-secret","token_type":"bearer","key":{"id":"k","name":"khode on test"},"user":{"email":"u@x.test","balance_usd":1.5}}`))
		}
	})
	return httptest.NewServer(mux)
}

func TestOrigin(t *testing.T) {
	cases := []struct{ in, want string }{
		{"", "http://localhost:8787"}, // default endpoint → bare origin
		{"http://localhost:8787/v1", "http://localhost:8787"},
		{"http://gw.lan:8787/", "http://gw.lan:8787"},
		{"https://khateway.example/v1/messages", "https://khateway.example"},
		{"https://khateway.example/v1/", "https://khateway.example"},
	}
	for _, tc := range cases {
		if got := origin(tc.in); got != tc.want {
			t.Errorf("origin(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestStart(t *testing.T) {
	srv := fakeGateway(t, &atomic.Int32{})
	defer srv.Close()

	code, err := Start(context.Background(), nil, srv.URL+"/v1", "khode on test")
	if err != nil {
		t.Fatal(err)
	}
	if code.DeviceCode != "devcode123" || code.UserCode != "ABCD-EFGH" {
		t.Errorf("code = %+v", code)
	}
	if code.Interval != 5 || code.ExpiresIn != 600 {
		t.Errorf("interval/expiry = %d/%d, want 5/600", code.Interval, code.ExpiresIn)
	}
	if code.VerificationURIComplete == "" {
		t.Errorf("verification_uri_complete missing")
	}

	if _, err := Start(context.Background(), nil, srv.URL+"/v1", ""); err == nil {
		t.Errorf("Start with empty device name should fail upstream")
	}
}

func TestPollOutcomes(t *testing.T) {
	srv := fakeGateway(t, &atomic.Int32{})
	defer srv.Close()

	// pending → sentinel, not error text
	if _, err := Poll(context.Background(), nil, srv.URL, "devcode123"); !errors.Is(err, ErrPending) {
		t.Errorf("first poll err = %v, want ErrPending", err)
	}
	// slow_down is not a sentinel — surface the message (the client should
	// simply back off; khateway's bucket answers it)
	if _, err := Poll(context.Background(), nil, srv.URL, "devcode123"); err == nil || errors.Is(err, ErrPending) {
		t.Errorf("second poll err = %v, want a non-sentinel slow_down error", err)
	}
	// success → grant
	res, err := Poll(context.Background(), nil, srv.URL, "devcode123")
	if err != nil {
		t.Fatal(err)
	}
	if res.AccessToken != "khat-secret" || res.KeyName != "khode on test" || res.Email != "u@x.test" || res.BalanceUSD != 1.5 {
		t.Errorf("result = %+v", res)
	}
	// unknown device code → expired sentinel
	if _, err := Poll(context.Background(), nil, srv.URL, "nope"); !errors.Is(err, ErrExpired) {
		t.Errorf("unknown code err = %v, want ErrExpired", err)
	}
}
