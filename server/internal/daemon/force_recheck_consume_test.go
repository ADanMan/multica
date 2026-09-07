package daemon

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"testing"
	"time"
)

// TestConsumeForceRecheckHints_ReNotesOnlyUnconfirmed pins the "consume the hint
// only on confirmed execution" contract (#7452). A drained force-recheck runtime
// the server did NOT echo as scanned must be re-noted so the next claim forces
// it again; a confirmed one is consumed.
func TestConsumeForceRecheckHints_ReNotesOnlyUnconfirmed(t *testing.T) {
	// A partial echo: the server scanned rt-1 but not rt-2 (e.g. rt-2's SELECT was
	// skipped). rt-2 must be re-noted, rt-1 consumed.
	d := &Daemon{}
	d.consumeForceRecheckHints([]string{"rt-1", "rt-2"}, []string{"rt-1"})
	got := d.drainWokenRuntimes()
	sort.Strings(got)
	if len(got) != 1 || got[0] != "rt-2" {
		t.Fatalf("re-noted set = %v, want [rt-2] (only the unconfirmed runtime)", got)
	}

	// A full echo (uncertain-after-send / legacy fallback): every drained runtime
	// is confirmed, so nothing is re-noted.
	d = &Daemon{}
	d.consumeForceRecheckHints([]string{"rt-1", "rt-2"}, []string{"rt-1", "rt-2"})
	if got := d.drainWokenRuntimes(); got != nil {
		t.Fatalf("full echo re-noted %v, want nothing", got)
	}
}

// TestConsumeForceRecheckHints_ReclaimFilledBatchReNotesAll is the reclaim-fills-
// batch regression (#7452, requirement 4): when stale reclaim already fills the
// batch the server returns before scanning the forced runtimes, so its echo is
// empty. The daemon must re-note the whole drained set — the force signal is NOT
// consumed — so the next cycle forces the re-check again.
func TestConsumeForceRecheckHints_ReclaimFilledBatchReNotesAll(t *testing.T) {
	d := &Daemon{}
	drained := []string{"rt-1", "rt-2", "rt-3"}
	// Empty echo == server scanned none of them (reclaim filled maxTasks first).
	d.consumeForceRecheckHints(drained, nil)
	got := d.drainWokenRuntimes()
	sort.Strings(got)
	want := []string{"rt-1", "rt-2", "rt-3"}
	if len(got) != len(want) {
		t.Fatalf("re-noted set = %v, want all drained %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("re-noted set = %v, want all drained %v", got, want)
		}
	}
}

// TestClaimTasksWSFirst_UncertainCooldownEchoesEmptyForceSet is the "targeted
// wakeup during the uncertain-claim cooldown still forces a re-check next cycle"
// regression (#7452). While the send-nothing cooldown is open ClaimTasksWSFirst
// scans nothing, so it must echo an EMPTY force-rechecked set — driving the
// daemon to re-note the whole drained set — even though a frame went out on the
// earlier uncertain attempt.
func TestClaimTasksWSFirst_UncertainCooldownEchoesEmptyForceSet(t *testing.T) {
	originalDelay := wsClaimUncertainFallbackDelay
	wsClaimUncertainFallbackDelay = time.Hour // keep the cooldown open for the test
	t.Cleanup(func() { wsClaimUncertainFallbackDelay = originalDelay })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tasks":[]}`))
	}))
	defer srv.Close()

	d := New(Config{ServerBaseURL: srv.URL, MaxConcurrentTasks: 4}, slog.New(slog.NewTextHandler(noopWriter{}, nil)))

	// Drive one uncertain sent-frame outcome so the HTTP-fallback cooldown opens.
	var mu sync.Mutex
	var item *wsOutbound
	frameQueued := make(chan struct{})
	generation := d.wsRPC.attach(func(frame []byte) (*wsOutbound, error) {
		mu.Lock()
		defer mu.Unlock()
		item = &wsOutbound{data: frame}
		close(frameQueued)
		return item, nil
	})
	d.wsRPC.markRPCV1Supported(generation)

	done := make(chan struct{})
	go func() {
		d.ClaimTasksWSFirst(context.Background(), "daemon-x", []string{"rt1"}, 2, "rt1")
		close(done)
	}()
	select {
	case <-frameQueued:
	case <-time.After(time.Second):
		t.Fatal("WS claim frame was not queued")
	}
	mu.Lock()
	item.beginWrite()
	mu.Unlock()
	d.wsRPC.attach(nil)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("uncertain ClaimTasksWSFirst did not return")
	}

	// The cooldown is now open. A claim that names a woken runtime scans nothing
	// and must echo an empty force-rechecked set.
	drained := []string{"rt1"}
	tasks, forceRechecked, err := d.ClaimTasksWSFirst(context.Background(), "daemon-x", []string{"rt1"}, 2, drained...)
	if err != nil {
		t.Fatalf("cooldown ClaimTasksWSFirst: %v", err)
	}
	if len(tasks) != 0 {
		t.Fatalf("cooldown claim returned %d tasks, want 0", len(tasks))
	}
	if len(forceRechecked) != 0 {
		t.Fatalf("cooldown echo = %v, want empty so the daemon re-notes the force set", forceRechecked)
	}

	// End to end: feeding that empty echo back re-notes the woken runtime.
	d.consumeForceRecheckHints(drained, forceRechecked)
	if got := d.drainWokenRuntimes(); len(got) != 1 || got[0] != "rt1" {
		t.Fatalf("re-noted set after cooldown = %v, want [rt1]", got)
	}
}

// TestClaimTasksWSFirst_UncertainAfterSendEchoesFullForceSet pins the opposite
// branch (#7452): when a claim frame actually went out and its outcome is
// uncertain, ClaimTasksWSFirst echoes the FULL drained force set so the daemon
// re-notes nothing — replaying the hint could double-claim a task the WS frame
// may have already committed.
func TestClaimTasksWSFirst_UncertainAfterSendEchoesFullForceSet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"tasks":[]}`))
	}))
	defer srv.Close()

	d := New(Config{ServerBaseURL: srv.URL, MaxConcurrentTasks: 4}, slog.New(slog.NewTextHandler(noopWriter{}, nil)))

	var mu sync.Mutex
	var item *wsOutbound
	frameQueued := make(chan struct{})
	generation := d.wsRPC.attach(func(frame []byte) (*wsOutbound, error) {
		mu.Lock()
		defer mu.Unlock()
		item = &wsOutbound{data: frame}
		close(frameQueued)
		return item, nil
	})
	d.wsRPC.markRPCV1Supported(generation)

	drained := []string{"rt1", "rt2"}
	done := make(chan struct{})
	var forceRechecked []string
	go func() {
		_, forceRechecked, _ = d.ClaimTasksWSFirst(context.Background(), "daemon-x", []string{"rt1"}, 2, drained...)
		close(done)
	}()
	select {
	case <-frameQueued:
	case <-time.After(time.Second):
		t.Fatal("WS claim frame was not queued")
	}
	mu.Lock()
	item.beginWrite() // frame on the wire — outcome is genuinely uncertain
	mu.Unlock()
	d.wsRPC.attach(nil)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("uncertain ClaimTasksWSFirst did not return")
	}

	sort.Strings(forceRechecked)
	if len(forceRechecked) != 2 || forceRechecked[0] != "rt1" || forceRechecked[1] != "rt2" {
		t.Fatalf("uncertain-after-send echo = %v, want the full drained set [rt1 rt2]", forceRechecked)
	}
	// Feeding it back re-notes nothing.
	d.consumeForceRecheckHints(drained, forceRechecked)
	if got := d.drainWokenRuntimes(); got != nil {
		t.Fatalf("uncertain-after-send re-noted %v, want nothing", got)
	}
}

// TestSignalTaskWakeup_FullChannelCoalescesRuntimeID is the "wakeup channel full
// → runtime id not lost" regression (#7452). signalTaskWakeup drops on a full
// channel, but a targeted wakeup's runtime id is the force-recheck signal, so it
// must be coalesced into the woken set instead of silently lost; the pending
// nudge already queued still drives the next claim.
func TestSignalTaskWakeup_FullChannelCoalescesRuntimeID(t *testing.T) {
	d := New(Config{MaxConcurrentTasks: 1}, slog.New(slog.NewTextHandler(noopWriter{}, nil)))

	// An unbuffered channel with no receiver is always "full" for a non-blocking
	// send, so the coalesce path runs.
	full := make(chan taskWakeup)
	d.signalTaskWakeup(full, "rt-burst")

	got := d.drainWokenRuntimes()
	if len(got) != 1 || got[0] != "rt-burst" {
		t.Fatalf("woken set after dropped wakeup = %v, want [rt-burst]", got)
	}

	// A catch-up wakeup (empty runtime id) has nothing to preserve and must not
	// enter the set.
	d.signalTaskWakeup(full, "")
	if got := d.drainWokenRuntimes(); got != nil {
		t.Fatalf("empty-id wakeup coalesced %v, want nothing", got)
	}
}
