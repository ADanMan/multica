package daemon

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"testing"

	"github.com/multica-ai/multica/server/pkg/agent"
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

func TestResolveAgentEntryAfterCodexDesktopPackageUpdate(t *testing.T) {
	root := t.TempDir()
	t.Setenv("PATH", filepath.Join(root, "empty"))
	t.Setenv("PATHEXT", ".EXE")
	t.Setenv("SHELL", filepath.Join(root, "fish"))

	oldPath := filepath.Join(root, "0.144.1", "app", "resources", "codex.exe")
	newInstall := filepath.Join(root, "0.144.3", "app")
	newPath := filepath.Join(newInstall, "resources", "codex.exe")
	writeExecStub(t, newPath)
	originalPaths := codexDesktopAppBundlePaths
	originalDetect := detectAgentVersion
	t.Cleanup(func() {
		codexDesktopAppBundlePaths = originalPaths
		detectAgentVersion = originalDetect
	})
	codexDesktopAppBundlePaths = func() []string {
		return codexDesktopAppBundlePathsFor("windows", "", filepath.Dir(newInstall))
	}
	detectAgentVersion = func(_ context.Context, candidate agent.Command) (string, error) {
		info, err := os.Stat(candidate.Path)
		want, wantErr := os.Stat(newPath)
		if err != nil || wantErr != nil || !os.SameFile(info, want) {
			t.Fatalf("version detection used %q, want %q", candidate.Path, newPath)
		}
		return "0.144.3", nil
	}

	d := newSelfHealTestDaemon()
	d.setAgentVersion("codex", "0.144.1")
	pinned := AgentEntry{Path: oldPath, Command: "codex"}
	updated, version, err := d.resolveAgentEntryForLaunch(t.Context(), "codex", pinned)
	if err != nil {
		t.Fatal(err)
	}
	info, statErr := os.Stat(updated.Path)
	want, wantErr := os.Stat(newPath)
	if statErr != nil || wantErr != nil || !os.SameFile(info, want) || version != "0.144.3" {
		t.Fatalf("resolved executable/version = (%q, %q), want (%q, %q)", updated.Path, version, newPath, "0.144.3")
	}
}
