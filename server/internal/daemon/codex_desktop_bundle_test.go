package daemon

import (
	"os"
	"path/filepath"
	"runtime"
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

func TestProbeAgentCLIsUsesRegisteredWindowsCodexCLI(t *testing.T) {
	pinNonCodexAgentsToMissingPaths(t)
	t.Setenv("PATH", t.TempDir())
	t.Setenv("MULTICA_CODEX_PATH", "")
	t.Setenv("PATHEXT", ".EXE")

	originalPaths := codexDesktopAppBundlePaths
	originalShellLookup := resolveAgentsViaLoginShell
	t.Cleanup(func() {
		codexDesktopAppBundlePaths = originalPaths
		resolveAgentsViaLoginShell = originalShellLookup
	})
	resolveAgentsViaLoginShell = func([]string) map[string]string { return nil }
	resetShellResolveCacheForTest(t)

	bundle := t.TempDir()
	bundledExe := filepath.Join(bundle, "app", "resources", "codex.exe")
	codexDesktopAppBundlePaths = func() []string {
		return codexDesktopAppBundlePathsFor("windows", "", bundle)
	}

	if entry, found := probeAgentCLIs()["codex"]; found {
		t.Fatalf("registered package without a CLI advertised Codex: %+v", entry)
	}
	writeExecutable := func(path string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, nil, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	assertPath := func(want string) {
		t.Helper()
		entry, found := probeAgentCLIs()["codex"]
		if !found {
			t.Fatalf("Codex was not discovered at %q", want)
		}
		gotFile, gotErr := os.Stat(entry.Path)
		wantFile, wantErr := os.Stat(want)
		if gotErr != nil || wantErr != nil || !os.SameFile(gotFile, wantFile) {
			t.Fatalf("Codex path = %q, want %q (stat: %v, %v)", entry.Path, want, gotErr, wantErr)
		}
	}
	writeExecutable(bundledExe)
	assertPath(bundledExe)

	command := "codex"
	if runtime.GOOS == "windows" {
		command += ".exe"
	}
	pathDir := t.TempDir()
	pathExe := filepath.Join(pathDir, command)
	writeExecutable(pathExe)
	t.Setenv("PATH", pathDir)
	assertPath(pathExe)

	override := filepath.Join(t.TempDir(), command)
	writeExecutable(override)
	t.Setenv("MULTICA_CODEX_PATH", override)
	assertPath(override)
}
