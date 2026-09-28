package terminal

import (
	"strings"
	"testing"
)

// Fixtures ported from src/main/persistent-shell.test.ts.

func TestParseSupportProbe(t *testing.T) {
	cases := []struct {
		name   string
		stdout string
		want   PersistentShellKind
	}{
		{"prefers tmux", "tmux\n", ShellKindTmux},
		{"falls back to screen", "screen\n", ShellKindScreen},
		{"none when explicit", "none\n", ShellKindNone},
		{"none when empty", "", ShellKindNone},
		{"ignores shell noise before the answer", "Welcome to the lab node\ntmux\n", ShellKindTmux},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ParseSupportProbe(tc.stdout); got != tc.want {
				t.Errorf("ParseSupportProbe(%q) = %q, want %q", tc.stdout, got, tc.want)
			}
		})
	}
}

func TestBuildSessionName(t *testing.T) {
	if got := BuildSessionName("/home/dev/train-runs", 1); got != "sshstudio-train-runs" {
		t.Errorf("BuildSessionName(index=1) = %q, want sshstudio-train-runs", got)
	}
	if got := BuildSessionName("/home/dev/train-runs", 3); got != "sshstudio-train-runs-3" {
		t.Errorf("BuildSessionName(index=3) = %q, want sshstudio-train-runs-3", got)
	}
	if got := BuildSessionName("/", 1); got != "sshstudio" {
		t.Errorf("BuildSessionName(root) = %q, want sshstudio", got)
	}
}

func TestNormalizeSessionName(t *testing.T) {
	if got := NormalizeSessionName("runs/exp 1:final"); got != "runs-exp-1-final" {
		t.Errorf("NormalizeSessionName = %q, want runs-exp-1-final", got)
	}
	if got := NormalizeSessionName("  "); got != SessionNamePrefix {
		t.Errorf("NormalizeSessionName(blank) = %q, want %q", got, SessionNamePrefix)
	}
	if got := NormalizeSessionName(strings.Repeat("a", 80)); len(got) != 60 {
		t.Errorf("NormalizeSessionName(long) length = %d, want 60", len(got))
	}
}

func TestParseSessionListTmux(t *testing.T) {
	sep := "\u0001"
	stdout := strings.Join([]string{
		strings.Join([]string{"sshstudio-runs", "4", "1", "1767225600"}, sep),
		strings.Join([]string{"other", "1", "0", "1767222000"}, sep),
	}, "\n")

	got := ParseSessionList(ShellKindTmux, stdout)
	if len(got) != 2 {
		t.Fatalf("got %d sessions, want 2", len(got))
	}

	if got[0].Name != "sshstudio-runs" || got[0].Windows == nil || *got[0].Windows != 4 || !got[0].Attached || got[0].CreatedAt == nil || *got[0].CreatedAt != 1767225600 {
		t.Errorf("session[0] = %+v", got[0])
	}
	if got[1].Name != "other" || got[1].Windows == nil || *got[1].Windows != 1 || got[1].Attached || got[1].CreatedAt == nil || *got[1].CreatedAt != 1767222000 {
		t.Errorf("session[1] = %+v", got[1])
	}
}

func TestParseSessionListTmuxEmpty(t *testing.T) {
	got := ParseSessionList(ShellKindTmux, "")
	if len(got) != 0 {
		t.Errorf("got %d sessions, want 0", len(got))
	}
}

func TestParseSessionListScreen(t *testing.T) {
	stdout := strings.Join([]string{
		"There are screens on:",
		"\t3121.sshstudio-runs\t(01/02/2026 10:11:12 AM)\t(Detached)",
		"\t3200.sshstudio-eval\t(01/02/2026 11:00:00 AM)\t(Attached)",
		"2 Sockets in /run/screen/S-dev.",
	}, "\n")

	got := ParseSessionList(ShellKindScreen, stdout)
	if len(got) != 2 {
		t.Fatalf("got %d sessions, want 2", len(got))
	}
	if got[0].Name != "3121.sshstudio-runs" || got[0].Attached {
		t.Errorf("session[0] = %+v", got[0])
	}
	if got[1].Name != "3200.sshstudio-eval" || !got[1].Attached {
		t.Errorf("session[1] = %+v", got[1])
	}
}

func TestBuildAttachCommandTmux(t *testing.T) {
	command, err := BuildAttachCommand(PersistentShellCommandInput{
		Kind:          ShellKindTmux,
		SessionName:   "sshstudio-runs",
		WorkspacePath: "/home/dev/train runs",
	})
	if err != nil {
		t.Fatalf("BuildAttachCommand() error = %v", err)
	}

	for _, want := range []string{
		"tmux has-session -t 'sshstudio-runs'",
		"exec tmux -u attach-session -t 'sshstudio-runs'",
		"exec tmux -u new-session -s 'sshstudio-runs' -c '/home/dev/train runs'",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("command %q missing %q", command, want)
		}
	}
}

func TestBuildAttachCommandOmitsWorkspaceWhenEmpty(t *testing.T) {
	command, err := BuildAttachCommand(PersistentShellCommandInput{Kind: ShellKindTmux, SessionName: "runs"})
	if err != nil {
		t.Fatalf("BuildAttachCommand() error = %v", err)
	}
	if strings.Contains(command, " -c ") {
		t.Errorf("command %q should not contain a -c flag", command)
	}
}

func TestBuildAttachCommandScreen(t *testing.T) {
	command, err := BuildAttachCommand(PersistentShellCommandInput{Kind: ShellKindScreen, SessionName: "runs", WorkspacePath: "/data"})
	if err != nil {
		t.Fatalf("BuildAttachCommand() error = %v", err)
	}
	want := "cd '/data'; exec screen -xRR -S 'runs'"
	if command != want {
		t.Errorf("command = %q, want %q", command, want)
	}
}

func TestBuildAttachCommandNoMultiplexer(t *testing.T) {
	_, err := BuildAttachCommand(PersistentShellCommandInput{Kind: ShellKindNone, SessionName: "runs"})
	if err == nil || !strings.Contains(err.Error(), "multiplexer") {
		t.Errorf("expected a multiplexer error, got %v", err)
	}
}

func TestBuildAttachCommandQuotesInjectionAttempt(t *testing.T) {
	command, err := BuildAttachCommand(PersistentShellCommandInput{
		Kind:        ShellKindTmux,
		SessionName: "runs'; rm -rf /tmp; echo '",
	})
	if err != nil {
		t.Fatalf("BuildAttachCommand() error = %v", err)
	}
	if strings.Contains(command, "rm -rf") {
		t.Errorf("command %q should not contain the injected rm -rf", command)
	}
}

func TestBuildAttachCommandWithEnv(t *testing.T) {
	command, err := BuildAttachCommand(PersistentShellCommandInput{
		Kind:        ShellKindTmux,
		SessionName: "runs",
		Env:         map[string]string{"DISPLAY": ":99"},
	})
	if err != nil {
		t.Fatalf("BuildAttachCommand() error = %v", err)
	}
	for _, want := range []string{
		"exec DISPLAY=':99' tmux -u attach-session",
		"exec DISPLAY=':99' tmux -u new-session",
	} {
		if !strings.Contains(command, want) {
			t.Errorf("command %q missing %q", command, want)
		}
	}
}

func TestBuildAttachCommandDropsInvalidEnvNames(t *testing.T) {
	command, err := BuildAttachCommand(PersistentShellCommandInput{
		Kind:        ShellKindTmux,
		SessionName: "runs",
		Env:         map[string]string{"BAD;NAME": "x"},
	})
	if err != nil {
		t.Fatalf("BuildAttachCommand() error = %v", err)
	}
	if strings.Contains(command, "BAD") {
		t.Errorf("command %q should not contain the invalid env name", command)
	}
}

func TestBuildSetSessionEnvCommand(t *testing.T) {
	cmd := BuildSetSessionEnvCommand(ShellKindTmux, "runs", "DISPLAY", ":99")
	if cmd == nil || *cmd != "tmux setenv -t 'runs' DISPLAY ':99'" {
		t.Errorf("BuildSetSessionEnvCommand = %v", cmd)
	}
}

func TestBuildSetSessionEnvCommandNoEquivalentOrInvalidName(t *testing.T) {
	if got := BuildSetSessionEnvCommand(ShellKindScreen, "runs", "DISPLAY", ":99"); got != nil {
		t.Errorf("screen should have no setenv equivalent, got %v", got)
	}
	if got := BuildSetSessionEnvCommand(ShellKindTmux, "runs", "DISPLAY; rm -rf /", ":99"); got != nil {
		t.Errorf("invalid env name should be rejected, got %v", got)
	}
}

func TestBuildKillSessionCommand(t *testing.T) {
	if cmd, err := BuildKillSessionCommand(ShellKindTmux, "runs"); err != nil || cmd != "tmux kill-session -t 'runs'" {
		t.Errorf("tmux kill command = %q, err = %v", cmd, err)
	}
	if cmd, err := BuildKillSessionCommand(ShellKindScreen, "3121.runs"); err != nil || cmd != "screen -S '3121.runs' -X quit" {
		t.Errorf("screen kill command = %q, err = %v", cmd, err)
	}
	if _, err := BuildKillSessionCommand(ShellKindNone, "runs"); err == nil || !strings.Contains(err.Error(), "multiplexer") {
		t.Errorf("expected a multiplexer error, got %v", err)
	}
}
