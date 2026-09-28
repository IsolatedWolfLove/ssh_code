package sftp

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCountLocalItemsAndBytes(t *testing.T) {
	dir := t.TempDir()

	// dir/
	//   a.txt (5 bytes)
	//   sub/
	//     b.txt (7 bytes)
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	subDir := filepath.Join(dir, "sub")
	if err := os.Mkdir(subDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(subDir, "b.txt"), []byte("goodbye"), 0o644); err != nil {
		t.Fatal(err)
	}

	items, err := CountLocalItems([]string{dir})
	if err != nil {
		t.Fatalf("CountLocalItems() error = %v", err)
	}
	if items != 2 {
		t.Errorf("CountLocalItems() = %d, want 2 (directories should not be counted)", items)
	}

	bytes, err := CountLocalBytes([]string{dir})
	if err != nil {
		t.Fatalf("CountLocalBytes() error = %v", err)
	}
	if bytes != 12 {
		t.Errorf("CountLocalBytes() = %d, want 12", bytes)
	}
}

func TestCountLocalItemsMixedFilesAndDirs(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "solo.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	items, err := CountLocalItems([]string{filepath.Join(dir, "solo.txt")})
	if err != nil {
		t.Fatalf("CountLocalItems() error = %v", err)
	}
	if items != 1 {
		t.Errorf("CountLocalItems() for a single file = %d, want 1", items)
	}
}

func TestIsCanceled(t *testing.T) {
	if !IsCanceled(canceledError{}) {
		t.Error("IsCanceled(canceledError{}) = false, want true")
	}
	if IsCanceled(nil) {
		t.Error("IsCanceled(nil) = true, want false")
	}
}
