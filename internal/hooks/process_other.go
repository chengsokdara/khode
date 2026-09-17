//go:build !unix

package hooks

import "os/exec"

// setHookProcessGroup has no cross-platform equivalent; CommandContext's
// default direct-child kill applies.
func setHookProcessGroup(cmd *exec.Cmd) {}
