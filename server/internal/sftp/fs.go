// Package sftp implements the remote-filesystem operations (readDir,
// readFile, writeFileAtomic, createEntry, renameEntry, deleteEntry, and
// upload/download transfers) that replace the SFTP-primary logic in
// src/main/ssh-session.ts for the Wails backend. It wraps github.com/pkg/sftp
// rather than reimplementing the SFTP protocol.
package sftp

import (
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"time"
)

// EntryKind mirrors contracts.ts's RemoteDirectoryEntry.kind union.
type EntryKind string

const (
	KindDirectory EntryKind = "directory"
	KindFile      EntryKind = "file"
)

// DirectoryEntry mirrors contracts.ts's RemoteDirectoryEntry.
type DirectoryEntry struct {
	Name          string
	Path          string
	Kind          EntryKind
	Size          int64
	HasSize       bool
	ModifiedAt    int64 // ms since epoch
	HasModifiedAt bool
}

// ReadDir mirrors readDirWithSftp in ssh-session.ts: lists remotePath,
// filtering out '.', '..', and in-flight `.part` transfer files, sorted
// directories-first then by name.
func ReadDir(client FileSystem, remotePath string) ([]DirectoryEntry, error) {
	infos, err := client.ReadDir(remotePath)
	if err != nil {
		return nil, err
	}

	entries := make([]DirectoryEntry, 0, len(infos))
	for _, info := range infos {
		name := info.Name()
		if name == "." || name == ".." || IsPartPath(name) {
			continue
		}

		entry := DirectoryEntry{
			Name: name,
			Path: path.Join(remotePath, name),
			Kind: KindFile,
		}
		if info.IsDir() {
			entry.Kind = KindDirectory
		} else {
			entry.Size = info.Size()
			entry.HasSize = true
		}
		entry.ModifiedAt = info.ModTime().UnixMilli()
		entry.HasModifiedAt = true
		entries = append(entries, entry)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].Kind != entries[j].Kind {
			return entries[i].Kind == KindDirectory
		}
		return entries[i].Name < entries[j].Name
	})

	return entries, nil
}

// ReadFile mirrors readFile in ssh-session.ts's SFTP path: reads the whole
// file as UTF-8 text.
func ReadFile(client FileSystem, remotePath string) (string, error) {
	f, err := client.Open(remotePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	data, err := io.ReadAll(f)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func buildTemporaryPath(remotePath string) string {
	dir := path.Dir(remotePath)
	base := path.Base(remotePath)
	return path.Join(dir, fmt.Sprintf(".%s.tmp-%d", base, time.Now().UnixMilli()))
}

func writeRemoteFile(client FileSystem, remotePath string, content string) error {
	f, err := client.Create(remotePath)
	if err != nil {
		return err
	}
	defer f.Close()

	if _, err := f.Write([]byte(content)); err != nil {
		return err
	}
	return f.Close()
}

func unlinkIfExists(client FileSystem, remotePath string) error {
	if _, err := client.Stat(remotePath); err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		// Some servers return a generic error rather than ENOENT; treat stat
		// failure as "nothing to remove" only when it's clearly not-found-like.
		if strings.Contains(strings.ToLower(err.Error()), "no such file") {
			return nil
		}
		return nil //nolint:nilerr // mirrors unlinkIfExists's exists-check-first semantics: a stat failure means there is nothing to unlink
	}
	return client.Remove(remotePath)
}

// WriteFileAtomic mirrors writeFileAtomic in ssh-session.ts: writes to a
// sibling temp path, then attempts an atomic rename into place (falling back
// to remove-then-rename, then a direct write, if the atomic rename fails —
// e.g. on servers without the OpenSSH rename extension).
func WriteFileAtomic(client FileSystem, remotePath string, content string) error {
	temporaryPath := buildTemporaryPath(remotePath)
	if err := writeRemoteFile(client, temporaryPath, content); err != nil {
		_ = client.Remove(temporaryPath)
		return err
	}
	return PublishFile(client, temporaryPath, remotePath)
}

// PublishFile preserves the old destination if the server cannot atomically
// replace it. A backup supports rollback on servers without posix-rename.
func PublishFile(client FileSystem, temporaryPath, remotePath string) error {
	if info, e := client.Stat(remotePath); e == nil && info.IsDir() {
		return fmt.Errorf("cannot replace a directory with a file: %s", remotePath)
	} else if e != nil && !os.IsNotExist(e) {
		return e
	}
	if e := client.PosixRename(temporaryPath, remotePath); e == nil {
		return nil
	}
	if _, e := client.Stat(remotePath); os.IsNotExist(e) {
		return client.Rename(temporaryPath, remotePath)
	} else if e != nil {
		return e
	}
	backup := buildTemporaryPath(remotePath) + ".backup"
	if _, e := client.Stat(backup); !os.IsNotExist(e) {
		return fmt.Errorf("cannot safely create backup for %s", remotePath)
	}
	if e := client.Rename(remotePath, backup); e != nil {
		return e
	}
	if e := client.Rename(temporaryPath, remotePath); e != nil {
		if restore := client.Rename(backup, remotePath); restore != nil {
			return fmt.Errorf("publish failed: %v; original retained at %s: %w", e, backup, restore)
		}
		return e
	}
	return client.Remove(backup)
}

// CreateEntry mirrors createEntry in ssh-session.ts: makes a directory or an
// empty file at parentPath/name.
func CreateEntry(client FileSystem, parentPath, name string, kind EntryKind) (DirectoryEntry, error) {
	if name == "" || name == "." || name == ".." || strings.ContainsAny(name, "/\\\x00") {
		return DirectoryEntry{}, fmt.Errorf("invalid entry name")
	}
	targetPath := path.Join(parentPath, name)

	if kind == KindDirectory {
		if err := client.Mkdir(targetPath); err != nil {
			return DirectoryEntry{}, err
		}
		return DirectoryEntry{Name: name, Path: targetPath, Kind: KindDirectory}, nil
	}

	if err := writeRemoteFile(client, targetPath, ""); err != nil {
		return DirectoryEntry{}, err
	}
	return DirectoryEntry{Name: name, Path: targetPath, Kind: KindFile, Size: 0, HasSize: true}, nil
}

// RenameEntry mirrors renameEntry in ssh-session.ts: renames path to
// dirname(path)/nextName, preferring the atomic OpenSSH rename extension.
func RenameEntry(client FileSystem, remotePath, nextName string) (DirectoryEntry, error) {
	if nextName == "" || nextName == "." || nextName == ".." || strings.ContainsAny(nextName, "/\\\x00") {
		return DirectoryEntry{}, fmt.Errorf("invalid entry name")
	}
	targetPath := path.Join(path.Dir(remotePath), nextName)

	if err := client.PosixRename(remotePath, targetPath); err != nil {
		if err := client.Rename(remotePath, targetPath); err != nil {
			return DirectoryEntry{}, err
		}
	}

	info, err := client.Stat(targetPath)
	if err != nil {
		return DirectoryEntry{Name: nextName, Path: targetPath, Kind: KindFile}, nil
	}

	entry := DirectoryEntry{Name: nextName, Path: targetPath, Kind: KindFile}
	if info.IsDir() {
		entry.Kind = KindDirectory
	} else {
		entry.Size = info.Size()
		entry.HasSize = true
	}
	entry.ModifiedAt = info.ModTime().UnixMilli()
	entry.HasModifiedAt = true
	return entry, nil
}

// DeleteEntry mirrors deleteRemotePath in ssh-session.ts: recursively removes
// a file or directory (including in-flight `.part` files, which the normal
// listing hides but which still make a directory non-empty).
func DeleteEntry(client FileSystem, remotePath string) error {
	info, err := client.Lstat(remotePath)
	if err != nil {
		return err
	}

	if !info.IsDir() {
		return client.Remove(remotePath)
	}

	infos, err := client.ReadDir(remotePath)
	if err != nil {
		return err
	}
	for _, child := range infos {
		name := child.Name()
		if name == "." || name == ".." {
			continue
		}
		if err := DeleteEntry(client, path.Join(remotePath, name)); err != nil {
			return err
		}
	}

	return client.RemoveDirectory(remotePath)
}
