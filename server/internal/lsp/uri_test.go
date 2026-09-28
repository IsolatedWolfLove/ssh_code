package lsp

import "testing"

func TestRemotePathToFileURIRoundTrip(t *testing.T) {
	cases := []string{"/workspace/app.ts", "/", "/a/b c/d.txt", "/a/../b"}
	for _, remotePath := range cases {
		uri, err := RemotePathToFileURI(remotePath)
		if err != nil {
			t.Fatalf("RemotePathToFileURI(%q): %v", remotePath, err)
		}
		got, ok := FileURIToRemotePath(uri)
		if !ok {
			t.Fatalf("FileURIToRemotePath(%q) failed to parse", uri)
		}
		want, err := normalizeRemotePath(remotePath)
		if err != nil {
			t.Fatalf("normalizeRemotePath(%q): %v", remotePath, err)
		}
		if got != want {
			t.Fatalf("round trip for %q: got %q, want %q", remotePath, got, want)
		}
	}
}

func TestRemotePathToFileURIRejectsRelativePath(t *testing.T) {
	if _, err := RemotePathToFileURI("relative"); err == nil {
		t.Fatal("expected an error for a relative path")
	}
}

func TestFileURIToRemotePathRejectsNonFileScheme(t *testing.T) {
	if _, ok := FileURIToRemotePath("http://example.com/a"); ok {
		t.Fatal("expected http:// to be rejected")
	}
}

func TestFileURIToRemotePathRejectsHostComponent(t *testing.T) {
	if _, ok := FileURIToRemotePath("file://remote-host/a"); ok {
		t.Fatal("expected a file:// URI with a host component to be rejected")
	}
}

func TestIsUnavailableMessage(t *testing.T) {
	cases := map[string]bool{
		"typescript-language-server is not installed. Run: npm install -D ...": true,
		"bash: typescript-language-server: command not found":                  true,
		"exited with code 127":     true,
		"connection reset by peer": false,
	}
	for message, want := range cases {
		if got := IsUnavailableMessage(message); got != want {
			t.Fatalf("IsUnavailableMessage(%q) = %v, want %v", message, got, want)
		}
	}
}

func TestStartCommandTypescript(t *testing.T) {
	got, err := StartCommand("/workspace/app", "typescript")
	if err != nil {
		t.Fatalf("StartCommand: %v", err)
	}
	want := "cd -- '/workspace/app'\n" +
		"if [ -x ./node_modules/.bin/typescript-language-server ]; then\n" +
		"  exec ./node_modules/.bin/typescript-language-server --stdio\n" +
		"elif command -v typescript-language-server >/dev/null 2>&1; then\n" +
		"  exec typescript-language-server --stdio\n" +
		"else\n" +
		"  echo 'typescript-language-server is not installed. Run: npm install -D typescript-language-server typescript' >&2\n" +
		"  exit 127\n" +
		"fi"
	if got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestStartCommandRejectsRelativeWorkspace(t *testing.T) {
	if _, err := StartCommand("relative/path", "typescript"); err == nil {
		t.Fatal("expected an error for a relative workspace path")
	}
}

func TestStartCommandUnsupportedLanguage(t *testing.T) {
	if _, err := StartCommand("/workspace", "python"); err == nil {
		t.Fatal("expected an error for an unsupported language")
	}
}
