//go:build unix

package hooks

import (
	"os/exec"
	"syscall"
)

// setHookProcessGroup puts the hook shell in its own process group and
// kills the whole group on timeout, so children of the hook command
// cannot outlive it and keep the output pipe (and cmd.Wait) open. Same
// treatment as the bash tool.
func setHookProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
}
