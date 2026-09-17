//go:build unix

package tools

import (
	"os/exec"
	"syscall"
)

// setBashProcessGroup puts the shell in its own process group and kills
// the whole group on timeout, so backgrounded children of the command
// cannot outlive it and keep the output pipe (and cmd.Wait) open.
func setBashProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		}
		return nil
	}
}
