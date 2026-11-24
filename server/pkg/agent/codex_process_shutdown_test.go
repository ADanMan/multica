//go:build !windows

package agent

import (
	"log/slog"
	"path/filepath"
	"testing"
	"time"
)

func TestCodexCloseReapsChildThatOutlivedCancelledLeader(t *testing.T) {
	codexGracefulShutdownTimeoutNanos.Store(int64(2 * time.Second))
	t.Cleanup(func() { codexGracefulShutdownTimeoutNanos.Store(0) })

	marker := filepath.Join(t.TempDir(), "child-started")
	fakePath := writeFakeCodexAppServer(t, "sleep 30 &\n"+
		"echo ready > "+marker+"\n"+
		"wait\n")
	backend, err := New("codex", Config{ExecutablePath: fakePath, Logger: slog.Default()})
	if err != nil {
		t.Fatal(err)
	}
	proc, err := backend.(*codexBackend).spawnCodexProcess(NewCommand(fakePath, nil),
		[]string{"app-server"}, ExecOptions{}, false, "", time.Second, time.Second, 1)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { proc.stopProcess(); proc.Close() })
	go proc.readStdout()
	waitForCodexMarker(t, marker, 5*time.Second)

	// Model the observed partial kill: the canceled shell dies, but the child
	// in its process group keeps stdout open. Keep the real stop callback
	// available to Close as a fallback so the fixture cannot leak the child.
	cancelled := make(chan struct{})
	proc.processCancelled = cancelled
	if err := proc.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	close(cancelled)

	started := time.Now()
	reaped := proc.Close()
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("canceled child cleanup took %s and reported reaped=%t", elapsed, reaped)
	}
	if !reaped {
		t.Fatal("canceled child's process group was not reaped")
	}
}
