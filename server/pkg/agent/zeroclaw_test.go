package agent

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewReturnsZeroclawBackend(t *testing.T) {
	t.Parallel()
	b, err := New("zeroclaw", Config{ExecutablePath: "/nonexistent/zeroclaw"})
	if err != nil {
		t.Fatalf("New(zeroclaw) error: %v", err)
	}
	if _, ok := b.(*zeroclawBackend); !ok {
		t.Fatalf("expected *zeroclawBackend, got %T", b)
	}
}

// fakeZeroclawACPScript impersonates `zeroclaw acp` for unit tests. Wire
// format mirrors the other Multica ACP fakes (dim/grok/qwenpaw): session/new
// returns sessionId, session/load accepts an existing session,
// session/set_model acknowledges a model switch, session/prompt returns
// stopReason=end_turn.
func fakeZeroclawACPScript() string {
	return `#!/bin/sh
while IFS= read -r line; do
  if [ -n "$ZEROCLAW_REQUESTS_FILE" ]; then
    printf '%s\n' "$line" >> "$ZEROCLAW_REQUESTS_FILE"
  fi
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"mcpCapabilities":{"http":true,"sse":true}}}}\n' "$id"
      ;;
    *'"method":"session/new"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"ses_zeroclaw_new"}}\n' "$id"
      ;;
    *'"method":"session/load"'*)
      if [ -n "$ZEROCLAW_SESSION_NOT_FOUND" ]; then
        printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32602,"message":"session not found"}}\n' "$id"
        exit 0
      fi
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
      ;;
    *'"method":"session/set_model"'*)
      if [ -n "$ZEROCLAW_SET_MODEL_FAIL" ]; then
        printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"model not available"}}\n' "$id"
        exit 0
      fi
      printf '{"jsonrpc":"2.0","id":%s,"result":{}}\n' "$id"
      ;;
    *'"method":"session/prompt"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":20,"cacheReadTokens":3,"cacheWriteTokens":2,"costUsdTicks":900}}}\n' "$id"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found"}}\n' "$id"
      ;;
  esac
done
`
}

func writeFakeZeroclawScript(t *testing.T, script string) string {
	t.Helper()
	dir := t.TempDir()
	bin := filepath.Join(dir, "zeroclaw")
	if err := os.WriteFile(bin, []byte(script), 0755); err != nil {
		t.Fatalf("write fake zeroclaw: %v", err)
	}
	return bin
}

// TestZeroclawSessionNew covers the fresh-session happy path: initialize,
// session/new, session/prompt, and a completed result carrying the new
// session id and usage.
func TestZeroclawSessionNew(t *testing.T) {
	t.Parallel()
	bin := writeFakeZeroclawScript(t, fakeZeroclawACPScript())

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	b, err := New("zeroclaw", Config{
		ExecutablePath: bin,
		Logger:         logger,
	})
	if err != nil {
		t.Fatalf("New(zeroclaw) error: %v", err)
	}

	ctx := context.Background()
	session, err := b.Execute(ctx, "test prompt", ExecOptions{
		Cwd: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	for range session.Messages {
	}

	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("expected completed, got status=%q error=%q", result.Status, result.Error)
	}
	if result.SessionID != "ses_zeroclaw_new" {
		t.Fatalf("expected sessionID ses_zeroclaw_new, got %q", result.SessionID)
	}
	if result.Usage == nil {
		t.Fatal("expected usage to be non-nil")
	}
}

// TestZeroclawResumeLoadsSession covers the resume-via-session/load happy
// path: a follow-up run with ResumeSessionID set uses session/load (not
// session/new) and reports ResumeRejected=false.
func TestZeroclawResumeLoadsSession(t *testing.T) {
	t.Parallel()
	bin := writeFakeZeroclawScript(t, fakeZeroclawACPScript())
	reqFile := filepath.Join(t.TempDir(), "requests.txt")

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	b, err := New("zeroclaw", Config{
		ExecutablePath: bin,
		Logger:         logger,
		Env:            map[string]string{"ZEROCLAW_REQUESTS_FILE": reqFile},
	})
	if err != nil {
		t.Fatalf("New(zeroclaw) error: %v", err)
	}

	ctx := context.Background()
	session, err := b.Execute(ctx, "test prompt", ExecOptions{
		Cwd:             t.TempDir(),
		ResumeSessionID: "ses_existing",
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	for range session.Messages {
	}

	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("expected completed, got status=%q error=%q", result.Status, result.Error)
	}
	// session/load returns no explicit sessionId, so resolveResumedSessionID
	// falls back to the requested id.
	if result.SessionID != "ses_existing" {
		t.Fatalf("expected sessionID ses_existing (fallback from load), got %q", result.SessionID)
	}
	if result.ResumeRejected {
		t.Fatal("expected ResumeRejected=false on successful load")
	}

	raw, err := os.ReadFile(reqFile)
	if err != nil {
		t.Fatalf("read requests file: %v", err)
	}
	requests := string(raw)
	if !strings.Contains(requests, `"method":"session/load"`) {
		t.Fatalf("expected session/load on resume, got requests:\n%s", requests)
	}
	if strings.Contains(requests, `"method":"session/new"`) {
		t.Fatalf("resume must not call session/new, got requests:\n%s", requests)
	}
}

// TestZeroclawResumeNotFound covers the resume-not-found path: session/load
// fails with a session-not-found error and the backend reports
// ResumeRejected=true so the daemon retries fresh.
func TestZeroclawResumeNotFound(t *testing.T) {
	t.Parallel()
	bin := writeFakeZeroclawScript(t, fakeZeroclawACPScript())

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	b, err := New("zeroclaw", Config{
		ExecutablePath: bin,
		Logger:         logger,
		Env:            map[string]string{"ZEROCLAW_SESSION_NOT_FOUND": "1"},
	})
	if err != nil {
		t.Fatalf("New(zeroclaw) error: %v", err)
	}

	ctx := context.Background()
	session, err := b.Execute(ctx, "test prompt", ExecOptions{
		Cwd:             t.TempDir(),
		ResumeSessionID: "ses_gone",
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	for range session.Messages {
	}

	result := <-session.Result
	if result.Status != "failed" {
		t.Fatalf("expected failed, got status=%q error=%q", result.Status, result.Error)
	}
	if !strings.Contains(result.Error, "session/load failed") {
		t.Fatalf("expected session/load failed error, got %q", result.Error)
	}
	if !result.ResumeRejected {
		t.Fatal("expected ResumeRejected=true on session not found")
	}
}

func TestZeroclawBlockedArgs(t *testing.T) {
	t.Parallel()
	if _, ok := zeroclawBlockedArgs["acp"]; !ok {
		t.Fatal("expected acp to be in zeroclawBlockedArgs")
	}
	if zeroclawBlockedArgs["acp"] != blockedStandalone {
		t.Fatalf("expected acp to be blockedStandalone, got %v", zeroclawBlockedArgs["acp"])
	}
	for _, flag := range []string{"--help", "-h", "login", "--login", "--auth"} {
		if _, ok := zeroclawBlockedArgs[flag]; !ok {
			t.Fatalf("expected %s to be in zeroclawBlockedArgs", flag)
		}
	}
}

func TestZeroclawListModels(t *testing.T) {
	t.Parallel()
	// A missing binary must fall back to an empty catalog rather than error,
	// matching the other ACP discovery backends.
	cat, err := ListModels(context.Background(), "zeroclaw", Command{Path: missingAgentExecutable(t, "zeroclaw")})
	if err != nil {
		t.Fatalf("zeroclaw ListModels should not error, got: %v", err)
	}
	if len(cat.Models) != 0 {
		t.Fatalf("zeroclaw ListModels should return empty catalog on missing binary, got %d models", len(cat.Models))
	}
	if !cat.Fallback {
		t.Fatal("zeroclaw ListModels should mark the empty catalog as a fallback")
	}
}

// TestZeroclawSetModel verifies that a requested model reaches
// session/set_model and the usage entry is attributed to it.
func TestZeroclawSetModel(t *testing.T) {
	t.Parallel()
	bin := writeFakeZeroclawScript(t, fakeZeroclawACPScript())
	reqFile := filepath.Join(t.TempDir(), "requests.txt")

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	b, err := New("zeroclaw", Config{
		ExecutablePath: bin,
		Logger:         logger,
		Env:            map[string]string{"ZEROCLAW_REQUESTS_FILE": reqFile},
	})
	if err != nil {
		t.Fatalf("New(zeroclaw) error: %v", err)
	}

	ctx := context.Background()
	session, err := b.Execute(ctx, "test prompt", ExecOptions{
		Cwd:   t.TempDir(),
		Model: "zeroclaw-large",
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	for range session.Messages {
	}

	result := <-session.Result
	if result.Status != "completed" {
		t.Fatalf("expected completed, got status=%q error=%q", result.Status, result.Error)
	}
	if _, ok := result.Usage["zeroclaw-large"]; !ok {
		t.Fatalf("expected usage entry for model 'zeroclaw-large', got %+v", result.Usage)
	}

	raw, err := os.ReadFile(reqFile)
	if err != nil {
		t.Fatalf("read requests file: %v", err)
	}
	if !strings.Contains(string(raw), `"method":"session/set_model"`) {
		t.Fatalf("expected session/set_model request, got:\n%s", raw)
	}
}

// TestZeroclawTimeout tests that a context timeout during session/new is
// reported as status=timeout. The fake script responds to initialize
// immediately, then sleeps 30s on session/new so the 5s context deadline
// expires during the session/new RPC.
func TestZeroclawTimeout(t *testing.T) {
	t.Parallel()

	script := `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}\n' "$id"
      ;;
    *'"method":"session/new"'*)
      sleep 30
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"ses_late"}}\n' "$id"
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found"}}\n' "$id"
      ;;
  esac
done`

	bin := writeFakeZeroclawScript(t, script)

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	b, err := New("zeroclaw", Config{
		ExecutablePath: bin,
		Logger:         logger,
	})
	if err != nil {
		t.Fatalf("New(zeroclaw) error: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	session, err := b.Execute(ctx, "test prompt", ExecOptions{
		Cwd: t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	for range session.Messages {
	}

	result := <-session.Result
	if result.Status != "timeout" {
		t.Fatalf("expected timeout, got status=%q error=%q", result.Status, result.Error)
	}
}

// TestZeroclawSessionLoadTransientError verifies that a transient
// network/handshake error on session/load does NOT set ResumeRejected=true,
// matching the invariant documented in grok.go and qwenpaw_test.go.
func TestZeroclawSessionLoadTransientError(t *testing.T) {
	t.Parallel()

	script := `#!/bin/sh
while IFS= read -r line; do
  id=$(printf '%s' "$line" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
  case "$line" in
    *'"method":"initialize"'*)
      printf '{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true}}}\n' "$id"
      ;;
    *'"method":"session/load"'*)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32000,"message":"rate limit exceeded"}}\n' "$id"
      exit 0
      ;;
    *)
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"method not found"}}\n' "$id"
      ;;
  esac
done
`
	bin := writeFakeZeroclawScript(t, script)

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelError}))
	b, err := New("zeroclaw", Config{
		ExecutablePath: bin,
		Logger:         logger,
	})
	if err != nil {
		t.Fatalf("New(zeroclaw) error: %v", err)
	}

	ctx := context.Background()
	session, err := b.Execute(ctx, "test prompt", ExecOptions{
		Cwd:             t.TempDir(),
		ResumeSessionID: "ses_transient",
	})
	if err != nil {
		t.Fatalf("Execute error: %v", err)
	}

	for range session.Messages {
	}

	result := <-session.Result
	if result.Status != "failed" {
		t.Fatalf("expected failed, got status=%q error=%q", result.Status, result.Error)
	}
	if !strings.Contains(result.Error, "session/load failed") {
		t.Fatalf("expected session/load failed error, got %q", result.Error)
	}
	if result.ResumeRejected {
		t.Fatal("expected ResumeRejected=false on transient load error")
	}
}
