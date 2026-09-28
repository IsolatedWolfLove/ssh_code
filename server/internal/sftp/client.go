package sftp

import (
	pkgsftp "github.com/pkg/sftp"
	"io"
	"os"
)

// FileSystem allows the same conflict, resume and search logic over SFTP or
// a shell-only SSH account, without duplicating transfer behavior.
type File interface {
	io.Reader
	io.Writer
	io.Seeker
	io.Closer
	Stat() (os.FileInfo, error)
}
type FileSystem interface {
	Open(string) (File, error)
	OpenFile(string, int) (File, error)
	Create(string) (File, error)
	Stat(string) (os.FileInfo, error)
	Lstat(string) (os.FileInfo, error)
	ReadDir(string) ([]os.FileInfo, error)
	Mkdir(string) error
	MkdirAll(string) error
	Remove(string) error
	RemoveDirectory(string) error
	Rename(string, string) error
	PosixRename(string, string) error
}
type Client struct{ *pkgsftp.Client }

func (c *Client) Open(p string) (File, error)                { return c.Client.Open(p) }
func (c *Client) OpenFile(p string, flags int) (File, error) { return c.Client.OpenFile(p, flags) }
func (c *Client) Create(p string) (File, error)              { return c.Client.Create(p) }
