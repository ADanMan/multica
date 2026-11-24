package daemon

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func codexDesktopWindowsInstallPath() string {
	systemDir, err := windows.GetSystemDirectory()
	if err != nil {
		return ""
	}
	powershell := filepath.Join(systemDir, "WindowsPowerShell", "v1.0", "powershell.exe")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Query the current user's Store registration, which tracks the install
	// across package updates and moves between volumes.
	const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Get-AppxPackage -Name OpenAI.Codex -PackageTypeFilter Main |
  Where-Object { $_.PackageFamilyName -eq 'OpenAI.Codex_2p2nqsd0c76g0' } |
  Sort-Object { [version]$_.Version } -Descending |
  Select-Object -First 1 -ExpandProperty InstallLocation`
	cmd := exec.CommandContext(ctx, powershell, "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NO_WINDOW}
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
