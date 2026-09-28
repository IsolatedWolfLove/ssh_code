package sftp

import (
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// ProgressCallback is invoked as bytes move during an upload/download.
// currentPath is the file currently being transferred; addedBytes is the
// delta since the last call. Mirrors emitByteProgress in ssh-session.ts,
// minus the throttling (callers should wrap this with a ThrottledEmitter if
// they want throttled UI updates).
type ProgressCallback func(currentPath string, addedBytes int64)

// TransferOptions configures Upload/Download.
type TransferOptions struct {
	SkipExisting bool
	OnSkip       func()
	// Ctx, when canceled, aborts the transfer mid-flight. Mirrors the
	// operationId-based cancellation in ssh-session.ts (registerOperationCancel).
	Ctx context.Context
	// OnProgress is called after each chunk is written.
	OnProgress ProgressCallback
}

// UploadFile stages bytes in a resumable sidecar and publishes only after close.
func UploadFile(client FileSystem, localPath, remotePath string, opts TransferOptions) error {
	if opts.Ctx != nil && opts.Ctx.Err() != nil {
		return canceledError{}
	}
	if opts.SkipExisting {
		if _, e := client.Stat(remotePath); e == nil {
			if opts.OnSkip != nil {
				opts.OnSkip()
			}
			return nil
		} else if !os.IsNotExist(e) {
			return e
		}
	}
	local, e := os.Open(localPath)
	if e != nil {
		return e
	}
	defer local.Close()
	info, e := local.Stat()
	if e != nil {
		return e
	}
	part := ToPartPath(remotePath)
	offset := int64(0)
	if p, e := client.Stat(part); e == nil {
		offset = ResolveResumeOffset(p.Size(), true, info.Size())
	} else if !os.IsNotExist(e) {
		return e
	}
	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	remote, e := client.OpenFile(part, flags)
	if e != nil {
		return e
	}
	defer remote.Close()
	if _, e = local.Seek(offset, io.SeekStart); e != nil {
		return e
	}
	if _, e = remote.Seek(offset, io.SeekStart); e != nil {
		return e
	}
	if offset > 0 && opts.OnProgress != nil {
		opts.OnProgress(remotePath, offset)
	}
	if e = copyWithProgress(opts.Ctx, remote, local, remotePath, opts.OnProgress); e != nil {
		return e
	}
	if e = remote.Close(); e != nil {
		return e
	}
	return PublishFile(client, part, remotePath)
}

func DownloadFile(client FileSystem, remotePath, localPath string, opts TransferOptions) error {
	if opts.Ctx != nil && opts.Ctx.Err() != nil {
		return canceledError{}
	}
	if opts.SkipExisting {
		if _, e := os.Stat(localPath); e == nil {
			if opts.OnSkip != nil {
				opts.OnSkip()
			}
			return nil
		} else if !os.IsNotExist(e) {
			return e
		}
	}
	remote, e := client.Open(remotePath)
	if e != nil {
		return e
	}
	defer remote.Close()
	info, e := remote.Stat()
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(localPath), 0o755); e != nil {
		return e
	}
	part := ToPartPath(localPath)
	offset := int64(0)
	if p, e := os.Stat(part); e == nil {
		offset = ResolveResumeOffset(p.Size(), true, info.Size())
	} else if !os.IsNotExist(e) {
		return e
	}
	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	local, e := os.OpenFile(part, flags, 0o600)
	if e != nil {
		return e
	}
	defer local.Close()
	if _, e = remote.Seek(offset, io.SeekStart); e != nil {
		return e
	}
	if _, e = local.Seek(offset, io.SeekStart); e != nil {
		return e
	}
	if offset > 0 && opts.OnProgress != nil {
		opts.OnProgress(remotePath, offset)
	}
	if e = copyWithProgress(opts.Ctx, local, remote, remotePath, opts.OnProgress); e != nil {
		return e
	}
	if e = local.Sync(); e != nil {
		return e
	}
	if e = local.Close(); e != nil {
		return e
	}
	return os.Rename(part, localPath)
}

// canceledError is returned by copyWithProgress when opts.Ctx is canceled
// mid-transfer. Mirrors TransferCanceledError in ssh-session.ts.
type canceledError struct{}

func (canceledError) Error() string { return "Transfer canceled" }

// IsCanceled reports whether err is (or wraps) a transfer-canceled error.
func IsCanceled(err error) bool {
	_, ok := err.(canceledError)
	return ok
}

func copyWithProgress(ctx context.Context, dst io.Writer, src io.Reader, currentPath string, onProgress ProgressCallback) error {
	buf := make([]byte, 256*1024)
	for {
		if ctx != nil {
			select {
			case <-ctx.Done():
				return canceledError{}
			default:
			}
		}

		n, readErr := src.Read(buf)
		if n > 0 {
			if _, writeErr := dst.Write(buf[:n]); writeErr != nil {
				return writeErr
			}
			if onProgress != nil {
				onProgress(currentPath, int64(n))
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

// UploadDirectory recursively uploads localDir's contents into remoteDir,
// creating remote subdirectories as needed. Mirrors uploadLocalDirectory in
// ssh-session.ts (conflict handling is left to the caller, same as there).
func UploadDirectory(client FileSystem, localDir, remoteDir string, opts TransferOptions) error {
	if opts.Ctx != nil && opts.Ctx.Err() != nil {
		return canceledError{}
	}
	if info, e := client.Stat(remoteDir); e == nil && !info.IsDir() {
		if opts.SkipExisting {
			if opts.OnSkip != nil {
				opts.OnSkip()
			}
			return nil
		}
		return fmt.Errorf("cannot replace file with folder: %s", remoteDir)
	}

	if err := client.MkdirAll(remoteDir); err != nil {
		return err
	}

	entries, err := os.ReadDir(localDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		localChild := filepath.Join(localDir, entry.Name())
		remoteChild := path.Join(remoteDir, entry.Name())
		if entry.IsDir() {
			if err := UploadDirectory(client, localChild, remoteChild, opts); err != nil {
				return err
			}
			continue
		}
		if err := UploadFile(client, localChild, remoteChild, opts); err != nil {
			return err
		}
	}

	return nil
}

// DownloadDirectory recursively downloads remoteDir's contents into
// localDir. Mirrors downloadDirectory in ssh-session.ts.
func DownloadDirectory(client FileSystem, remoteDir, localDir string, opts TransferOptions) error {
	if opts.Ctx != nil && opts.Ctx.Err() != nil {
		return canceledError{}
	}
	if info, e := os.Stat(localDir); e == nil && !info.IsDir() {
		if opts.SkipExisting {
			if opts.OnSkip != nil {
				opts.OnSkip()
			}
			return nil
		}
		return fmt.Errorf("cannot replace file with folder: %s", localDir)
	}

	if err := os.MkdirAll(localDir, 0o755); err != nil {
		return err
	}

	entries, err := ReadDir(client, remoteDir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		if entry.Name == "" || entry.Name == "." || entry.Name == ".." || filepath.Base(entry.Name) != entry.Name || strings.ContainsAny(entry.Name, "/\\") {
			return fmt.Errorf("invalid remote entry name: %q", entry.Name)
		}
		localChild := filepath.Join(localDir, entry.Name)
		if entry.Kind == KindDirectory {
			if err := DownloadDirectory(client, entry.Path, localChild, opts); err != nil {
				return err
			}
			continue
		}
		if err := DownloadFile(client, entry.Path, localChild, opts); err != nil {
			return err
		}
	}

	return nil
}

// CountLocalItems mirrors countLocalItems in ssh-session.ts: counts files
// (not directories) under each of localPaths, recursively.
func CountLocalItems(localPaths []string) (int, error) {
	total := 0
	for _, p := range localPaths {
		info, err := os.Stat(p)
		if err != nil {
			return total, err
		}
		if !info.IsDir() {
			total++
			continue
		}
		err = filepath.WalkDir(p, func(_ string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() {
				total++
			}
			return nil
		})
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// CountLocalBytes mirrors countLocalBytes in ssh-session.ts: sums file sizes
// under each of localPaths, recursively.
func CountLocalBytes(localPaths []string) (int64, error) {
	var total int64
	for _, p := range localPaths {
		info, err := os.Stat(p)
		if err != nil {
			return total, err
		}
		if !info.IsDir() {
			total += info.Size()
			continue
		}
		err = filepath.WalkDir(p, func(_ string, d os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.IsDir() {
				if fi, statErr := d.Info(); statErr == nil {
					total += fi.Size()
				}
			}
			return nil
		})
		if err != nil {
			return total, err
		}
	}
	return total, nil
}
