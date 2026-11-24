package daemon

import (
	"path/filepath"
	"slices"
	"testing"
)

func TestCodexDesktopAppBundlePathsWindows(t *testing.T) {
	packagedApp := filepath.Join(t.TempDir(), "OpenAI.Codex_26.1120.5083.0_x64__2p2nqsd0c76g0")
	want := []string{filepath.Join(packagedApp, "app", "resources", "codex.exe")}
	got := codexDesktopAppBundlePathsFor("windows", t.TempDir(), packagedApp)
	if !slices.Equal(got, want) {
		t.Fatalf("Codex Desktop candidates = %q, want %q", got, want)
	}

	if got := codexDesktopAppBundlePathsFor("windows", t.TempDir(), ""); len(got) != 0 {
		t.Fatalf("Codex Desktop candidates without a registered package = %q, want none", got)
	}
}
