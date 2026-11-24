package daemon

import (
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestRunTaskFreshSessionRetryUsesRemainingTimeout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell-script agent fixture is POSIX-only")
	}
	t.Setenv("HOME", t.TempDir())
	t.Setenv("CLAUDE_CONFIG_DIR", t.TempDir())
	root := t.TempDir()
	delayed := filepath.Join(root, "delayed")
	t.Setenv("TIMEOUT_FIXTURE_DELAYED", delayed)
	fake := filepath.Join(root, "claude")
	writeTestExecutable(t, fake, []byte(`#!/bin/sh
case "$*" in *--version*) echo '2.1.292'; exit 0;; esac
IFS= read -r input
if [ -f "$TIMEOUT_FIXTURE_DELAYED" ]; then sleep 1.5; fi
case "$*" in
  *--resume*) printf '%s\n' 'No conversation found with session ID: timeout-session' >&2
    printf '%s\n' '{"type":"result","subtype":"error_during_execution","is_error":true}';;
  *) printf '%s\n' '{"type":"result","subtype":"success","session_id":"timeout-session","result":"done"}';;
esac
cat >/dev/null
`))
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	d := &Daemon{
		client: NewClient(srv.URL), logger: logger,
		workspaces: make(map[string]*workspaceState), activeEnvRoots: make(map[string]int),
		runtimeIndex: map[string]Runtime{"test-rt": {ID: "test-rt", Provider: "claude"}},
		cfg: Config{
			WorkspacesRoot: t.TempDir(), AgentTimeout: 2500 * time.Millisecond, ServerBaseURL: srv.URL,
			Agents: map[string]AgentEntry{"claude": {Path: fake}},
		},
	}
	task := Task{
		ID: "first-task", WorkspaceID: "test-ws", RuntimeID: "test-rt",
		AgentID: "test-agent", AuthToken: "mat_test_timeout", ChatSessionID: "test-chat",
		ChatMessage: "Synthetic timeout fixture",
		Agent:       &AgentData{ID: "test-agent", Name: "test"},
	}
	first, err := d.runTask(t.Context(), task, "claude", 0, logger)
	if err != nil || first.Status != "completed" || first.SessionID == "" {
		t.Fatalf("initial run status=%q session=%q err=%v", first.Status, first.SessionID, err)
	}
	if err := os.WriteFile(delayed, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	task.ID = "followup-task"
	task.PriorWorkDir, task.PriorSessionID = first.WorkDir, first.SessionID
	got, err := d.runTask(t.Context(), task, "claude", 0, logger)
	if err != nil || got.FailureReason != "timeout" || got.RetiredSessionID != first.SessionID {
		t.Fatalf("retried run status=%q failure=%q retired session=%q err=%v", got.Status, got.FailureReason, got.RetiredSessionID, err)
	}
}
