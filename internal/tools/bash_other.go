//go:build !unix

package tools

import "os/exec"

// setBashProcessGroup has no cross-platform equivalent; CommandContext's
// default direct-child kill applies.
func setBashProcessGroup(cmd *exec.Cmd) {}
