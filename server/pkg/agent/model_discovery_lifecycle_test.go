//go:build !windows

package agent

import (
	"bytes"
	"context"
	"path/filepath"
	"runtime/pprof"
	"strings"
	"testing"
	"time"
)

func TestModelDiscoveryReapsCommandWatchers(t *testing.T) {
	t.Run("zcode", func(t *testing.T) {
		bin := writeFakeZcodeScript(t, fakeZcodeDiscoveryScript)
		assertDiscoveryReapsCommandWatchers(t, func() {
			catalog, err := discoverZcodeModels(context.Background(), NewCommand(bin, nil))
			if err != nil || len(catalog.Models) != 2 {
				t.Fatalf("discovery=%+v err=%v", catalog, err)
			}
		})
	})
	t.Run("acp", func(t *testing.T) {
		bin := filepath.Join(t.TempDir(), "hermes")
		writeTestExecutable(t, bin, []byte(hermesACPCatalogScript()))
		assertDiscoveryReapsCommandWatchers(t, func() {
			models, err := discoverHermesModels(context.Background(), NewCommand(bin, nil))
			if err != nil || len(models) != 2 {
				t.Fatalf("discovery=%+v err=%v", models, err)
			}
		})
	})
	t.Run("muse", func(t *testing.T) {
		bin, _, _ := writeFakeMuseServe(t, false)
		assertDiscoveryReapsCommandWatchers(t, func() {
			catalog, err := discoverMuseModels(context.Background(), NewCommand(bin, nil))
			if err != nil || !catalog.Fallback {
				t.Fatalf("discovery=%+v err=%v", catalog, err)
			}
		})
	})
}

// Keep these probes serial because the watcher count is process-wide.
func assertDiscoveryReapsCommandWatchers(t *testing.T, discover func()) {
	t.Helper()
	watchers := func() int {
		t.Helper()
		var profile bytes.Buffer
		if err := pprof.Lookup("goroutine").WriteTo(&profile, 2); err != nil {
			t.Fatal(err)
		}
		return strings.Count(profile.String(), "os/exec.(*Cmd).watchCtx(")
	}
	before := watchers()
	for range 12 {
		discover()
	}
	deadline := time.Now().Add(time.Second)
	for {
		after := watchers()
		if after <= before+1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("CommandContext watchers leaked across repeated discovery: before=%d after=%d", before, after)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
