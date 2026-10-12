//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func inheritOwnership(name string) error {
	if os.Getuid() != 0 {
		return nil
	}
	info, err := os.Stat(filepath.Dir(name))
	if err != nil {
		return err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return nil
	}
	err = os.Chown(name, int(stat.Uid), int(stat.Gid))
	for _, ignored := range []error{syscall.EACCES, syscall.EINVAL, syscall.ENOSYS, syscall.EPERM, syscall.EROFS} {
		if errors.Is(err, ignored) {
			return nil
		}
	}
	return err
}
