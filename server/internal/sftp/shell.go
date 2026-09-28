package sftp

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
)

// ShellClient supplies the filesystem for servers without an SFTP subsystem.
// Commands use POSIX tools and quote every remote path as a shell argument.
type ShellClient struct{ Client *ssh.Client }

func (c *ShellClient) run(command string) (string, error) {
	s, e := c.Client.NewSession()
	if e != nil {
		return "", e
	}
	defer s.Close()
	var stderr bytes.Buffer
	s.Stderr = &stderr
	b, e := s.Output(command)
	if e != nil {
		if v, ok := e.(*ssh.ExitError); ok && v.ExitStatus() == 44 {
			return "", os.ErrNotExist
		}
		return "", fmt.Errorf("remote filesystem: %w: %s", e, strings.TrimSpace(stderr.String()))
	}
	return string(b), nil
}
func (c *ShellClient) Stat(p string) (os.FileInfo, error)  { return c.stat(p, true) }
func (c *ShellClient) Lstat(p string) (os.FileInfo, error) { return c.stat(p, false) }
func (c *ShellClient) stat(p string, follow bool) (os.FileInfo, error) {
	q := quoteForShell(p)
	linkCheck := ""
	if !follow {
		linkCheck = `if [ -L "$p" ]; then printf '0 0 l'; exit 0; fi; `
	}
	out, e := c.run("p=" + q + `; ` + linkCheck + `[ -e "$p" ] || [ -L "$p" ] || exit 44; if [ -d "$p" ]; then kind=d; size=0; else kind=f; size=$(stat -c %s -- "$p" 2>/dev/null || stat -f %z "$p" 2>/dev/null || wc -c < "$p") || exit 1; fi; mtime=$(stat -c %Y -- "$p" 2>/dev/null || stat -f %m "$p" 2>/dev/null || echo 0); printf '%s %s %s' "$size" "$mtime" "$kind"`)
	if e != nil {
		return nil, e
	}
	v := strings.Fields(out)
	if len(v) != 3 {
		return nil, fmt.Errorf("invalid remote stat response")
	}
	size, e := strconv.ParseInt(v[0], 10, 64)
	if e != nil {
		return nil, e
	}
	stamp, _ := strconv.ParseInt(v[1], 10, 64)
	mode := os.FileMode(0o600)
	if v[2] == "l" {
		mode |= os.ModeSymlink
	}
	if v[2] == "d" {
		mode |= os.ModeDir
	}
	return shellInfo{path.Base(p), size, mode, time.Unix(stamp, 0)}, nil
}
func (c *ShellClient) ReadDir(p string) ([]os.FileInfo, error) {
	out, e := c.run("cd -- " + quoteForShell(p) + ` || exit 1; for entry in ./* ./.[!.]* ./..?*; do [ -e "$entry" ] || [ -L "$entry" ] || continue; printf '%s\000' "${entry#./}"; done`)
	if e != nil {
		return nil, e
	}
	result := []os.FileInfo{}
	for _, name := range strings.Split(out, "\x00") {
		if name == "" {
			continue
		}
		info, e := c.Stat(path.Join(p, name))
		if e != nil {
			return nil, e
		}
		result = append(result, info)
	}
	return result, nil
}
func (c *ShellClient) Mkdir(p string) error { _, e := c.run("mkdir -- " + quoteForShell(p)); return e }
func (c *ShellClient) MkdirAll(p string) error {
	_, e := c.run("mkdir -p -- " + quoteForShell(p))
	return e
}
func (c *ShellClient) Remove(p string) error { _, e := c.run("rm -- " + quoteForShell(p)); return e }
func (c *ShellClient) RemoveDirectory(p string) error {
	_, e := c.run("rmdir -- " + quoteForShell(p))
	return e
}
func (c *ShellClient) Rename(old, new string) error {
	_, e := c.run("mv -- " + quoteForShell(old) + " " + quoteForShell(new))
	return e
}
func (c *ShellClient) PosixRename(old, new string) error { return c.Rename(old, new) }
func (c *ShellClient) Open(p string) (File, error) {
	if _, e := c.Stat(p); e != nil {
		return nil, e
	}
	return &shellFile{client: c, path: p}, nil
}
func (c *ShellClient) Create(p string) (File, error) {
	return c.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
}
func (c *ShellClient) OpenFile(p string, flags int) (File, error) {
	if flags&os.O_WRONLY == 0 {
		return c.Open(p)
	}
	q := quoteForShell(p)
	command := ": >> " + q
	if flags&os.O_TRUNC != 0 {
		command = ": > " + q
	}
	if _, e := c.run(command); e != nil {
		return nil, e
	}
	return &shellFile{client: c, path: p, write: true}, nil
}

type shellInfo struct {
	name     string
	size     int64
	mode     os.FileMode
	modified time.Time
}

func (s shellInfo) Name() string       { return s.name }
func (s shellInfo) Size() int64        { return s.size }
func (s shellInfo) Mode() os.FileMode  { return s.mode }
func (s shellInfo) ModTime() time.Time { return s.modified }
func (s shellInfo) IsDir() bool        { return s.mode.IsDir() }
func (s shellInfo) Sys() any           { return nil }

type shellFile struct {
	client    *ShellClient
	path      string
	offset    int64
	write     bool
	session   *ssh.Session
	reader    io.Reader
	writer    io.WriteCloser
	stderr    bytes.Buffer
	closeOnce sync.Once
	closeErr  error
	waited    bool
}

func (f *shellFile) Stat() (os.FileInfo, error) { return f.client.Stat(f.path) }
func (f *shellFile) Seek(offset int64, whence int) (int64, error) {
	if f.session != nil {
		return 0, fmt.Errorf("cannot seek after shell streaming starts")
	}
	if whence != io.SeekStart || offset < 0 {
		return 0, fmt.Errorf("unsupported seek")
	}
	f.offset = offset
	return offset, nil
}
func (f *shellFile) start() error {
	if f.session != nil {
		return nil
	}
	s, e := f.client.Client.NewSession()
	if e != nil {
		return e
	}
	f.session = s
	s.Stderr = &f.stderr
	command := "tail -c +" + strconv.FormatInt(f.offset+1, 10) + " -- " + quoteForShell(f.path)
	if f.write {
		f.writer, e = s.StdinPipe()
		command = "cat >> " + quoteForShell(f.path)
	} else {
		f.reader, e = s.StdoutPipe()
	}
	if e != nil {
		s.Close()
		return e
	}
	if e = s.Start(command); e != nil {
		s.Close()
		return e
	}
	return nil
}
func (f *shellFile) Read(b []byte) (int, error) {
	if f.write {
		return 0, fmt.Errorf("write-only file")
	}
	if e := f.start(); e != nil {
		return 0, e
	}
	n, e := f.reader.Read(b)
	if e == io.EOF && !f.waited {
		f.waited = true
		if err := f.session.Wait(); err != nil {
			return n, fmt.Errorf("remote read: %w: %s", err, f.stderr.String())
		}
	}
	return n, e
}
func (f *shellFile) Write(b []byte) (int, error) {
	if !f.write {
		return 0, fmt.Errorf("read-only file")
	}
	if e := f.start(); e != nil {
		return 0, e
	}
	return f.writer.Write(b)
}
func (f *shellFile) Close() error {
	f.closeOnce.Do(func() {
		if f.session == nil {
			return
		}
		if f.write {
			_ = f.writer.Close()
			f.closeErr = f.session.Wait()
		}
		_ = f.session.Close()
	})
	return f.closeErr
}
