package vision

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"testing"
)

// --- DemuxMJPEG / drainFrames -----------------------------------------------

func fakeFrame(tag byte) []byte {
	// SOI + a payload byte identifying the frame + EOI. Content doesn't need
	// to be valid JPEG since DemuxMJPEG only scans for the SOI/EOI markers.
	return append(append([]byte{0xFF, 0xD8}, tag, tag, tag), 0xFF, 0xD9)
}

type chunkReader struct {
	chunks [][]byte
	i      int
}

func (c *chunkReader) Read(p []byte) (int, error) {
	if c.i >= len(c.chunks) {
		return 0, io.EOF
	}
	chunk := c.chunks[c.i]
	c.i++
	n := copy(p, chunk)
	return n, nil
}

func newChunkReader(chunks ...[]byte) *chunkReader {
	return &chunkReader{chunks: chunks}
}

func splitOneByte(data []byte) [][]byte {
	chunks := make([][]byte, 0, len(data))
	for _, b := range data {
		chunks = append(chunks, []byte{b})
	}
	return chunks
}

func TestDemuxMJPEG_SingleFrameOneChunk(t *testing.T) {
	frame := fakeFrame(1)
	var got [][]byte
	var seqs []int

	err := DemuxMJPEG(newChunkReader(frame), func(f []byte, seq int) {
		got = append(got, f)
		seqs = append(seqs, seq)
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	if len(got) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(got))
	}
	if !bytes.Equal(got[0], frame) {
		t.Errorf("frame mismatch: got %v want %v", got[0], frame)
	}
	if seqs[0] != 0 {
		t.Errorf("seq = %d, want 0", seqs[0])
	}
}

func TestDemuxMJPEG_MultipleFramesInOneChunk(t *testing.T) {
	f1, f2, f3 := fakeFrame(1), fakeFrame(2), fakeFrame(3)
	combined := append(append(append([]byte{}, f1...), f2...), f3...)

	var got [][]byte
	err := DemuxMJPEG(newChunkReader(combined), func(f []byte, seq int) {
		got = append(got, f)
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("expected 3 frames, got %d", len(got))
	}
	for i, want := range [][]byte{f1, f2, f3} {
		if !bytes.Equal(got[i], want) {
			t.Errorf("frame %d mismatch: got %v want %v", i, got[i], want)
		}
	}
}

func TestDemuxMJPEG_FrameSplitAcrossChunks_OneBytePerRead(t *testing.T) {
	f1, f2 := fakeFrame(1), fakeFrame(2)
	combined := append(append([]byte{}, f1...), f2...)

	var got [][]byte
	err := DemuxMJPEG(newChunkReader(splitOneByte(combined)...), func(f []byte, seq int) {
		got = append(got, f)
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 frames, got %d", len(got))
	}
	if !bytes.Equal(got[0], f1) || !bytes.Equal(got[1], f2) {
		t.Errorf("frame mismatch: got %v, %v", got[0], got[1])
	}
}

func TestDemuxMJPEG_SplitExactlyAtSOIEOIBoundary(t *testing.T) {
	f1, f2 := fakeFrame(1), fakeFrame(2)
	combined := append(append([]byte{}, f1...), f2...)

	// Split precisely between f1's EOI and f2's SOI.
	boundary := len(f1)
	chunks := [][]byte{combined[:boundary], combined[boundary:]}

	var got [][]byte
	err := DemuxMJPEG(newChunkReader(chunks...), func(f []byte, seq int) {
		got = append(got, f)
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	if len(got) != 2 || !bytes.Equal(got[0], f1) || !bytes.Equal(got[1], f2) {
		t.Fatalf("got %v frames, want [f1 f2]", got)
	}

	// Now split mid-frame: right after f2's SOI marker, before its payload/EOI.
	mid := boundary + 2 // boundary + len(SOI)
	chunksMid := [][]byte{combined[:mid], combined[mid:]}
	got = nil
	err = DemuxMJPEG(newChunkReader(chunksMid...), func(f []byte, seq int) {
		got = append(got, f)
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	if len(got) != 2 || !bytes.Equal(got[0], f1) || !bytes.Equal(got[1], f2) {
		t.Fatalf("got %v frames, want [f1 f2] (mid-marker split)", got)
	}
}

func TestDemuxMJPEG_LeadingGarbageBeforeFirstSOI(t *testing.T) {
	garbage := []byte{0x00, 0x01, 0x02}
	frame := fakeFrame(9)
	combined := append(append([]byte{}, garbage...), frame...)

	var got [][]byte
	err := DemuxMJPEG(newChunkReader(combined), func(f []byte, seq int) {
		got = append(got, f)
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	if len(got) != 1 || !bytes.Equal(got[0], frame) {
		t.Fatalf("got %v, want [frame] (garbage before SOI must be dropped)", got)
	}
}

func TestDemuxMJPEG_IncompleteFrameNeverCompleted(t *testing.T) {
	// SOI with no EOI ever arriving: DemuxMJPEG must return cleanly at EOF
	// without calling onFrame.
	incomplete := []byte{0xFF, 0xD8, 0x01, 0x02, 0x03}

	calls := 0
	err := DemuxMJPEG(newChunkReader(incomplete), func(f []byte, seq int) {
		calls++
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	if calls != 0 {
		t.Errorf("expected 0 frames for an incomplete stream, got %d", calls)
	}
}

func TestDemuxMJPEG_SequenceNumbersIncrementAcrossManyFrames(t *testing.T) {
	var combined []byte
	for i := 0; i < 5; i++ {
		combined = append(combined, fakeFrame(byte(i))...)
	}

	var seqs []int
	err := DemuxMJPEG(newChunkReader(combined), func(f []byte, seq int) {
		seqs = append(seqs, seq)
	})
	if err != nil {
		t.Fatalf("DemuxMJPEG: %v", err)
	}
	for i, seq := range seqs {
		if seq != i {
			t.Errorf("seq[%d] = %d, want %d", i, seq, i)
		}
	}
}

type erroringReader struct{ err error }

func (r erroringReader) Read(p []byte) (int, error) { return 0, r.err }

func TestDemuxMJPEG_PropagatesNonEOFError(t *testing.T) {
	wantErr := errors.New("boom")
	err := DemuxMJPEG(erroringReader{wantErr}, func(f []byte, seq int) {})
	if !errors.Is(err, wantErr) {
		t.Fatalf("err = %v, want %v", err, wantErr)
	}
}

// --- BuildFfmpegCommand ------------------------------------------------------

func TestBuildFfmpegCommand(t *testing.T) {
	got := BuildFfmpegCommand("/usr/bin/ffmpeg", ":99", StreamOptions{Width: 1280, Height: 720, FPS: 30, Quality: 5})
	want := "'/usr/bin/ffmpeg' -loglevel error " +
		"-f x11grab -video_size 1280x720 -framerate 30 -i ':99' " +
		"-vf fps=30 " +
		"-f mjpeg -q:v 5 -threads 1 " +
		"pipe:1"
	if got != want {
		t.Errorf("BuildFfmpegCommand:\n got:  %s\n want: %s", got, want)
	}
}

func TestBuildFfmpegCommand_ClampsOutOfRangeValues(t *testing.T) {
	got := BuildFfmpegCommand("ffmpeg", ":0", StreamOptions{Width: 0, Height: -5, FPS: 999, Quality: 1})
	want := "'ffmpeg' -loglevel error " +
		"-f x11grab -video_size 1x1 -framerate 60 -i ':0' " +
		"-vf fps=60 " +
		"-f mjpeg -q:v 2 -threads 1 " +
		"pipe:1"
	if got != want {
		t.Errorf("BuildFfmpegCommand (clamped):\n got:  %s\n want: %s", got, want)
	}
}

// --- ResolveFfmpegPath -------------------------------------------------------

func execReturning(byCommandSubstring map[string]string) ExecFunc {
	return func(command string) (string, string, int, error) {
		for substr, stdout := range byCommandSubstring {
			if contains(command, substr) {
				return stdout, "", 0, nil
			}
		}
		return "UNSUPPORTED\n", "", 0, nil
	}
}

func contains(s, substr string) bool {
	return len(substr) > 0 && (func() bool {
		for i := 0; i+len(substr) <= len(s); i++ {
			if s[i:i+len(substr)] == substr {
				return true
			}
		}
		return false
	})()
}

func TestResolveFfmpegPath_FirstCandidateSupported(t *testing.T) {
	exec := execReturning(map[string]string{
		"/usr/bin/ffmpeg": "SUPPORTED\n",
	})
	got, err := ResolveFfmpegPath(exec)
	if err != nil {
		t.Fatalf("ResolveFfmpegPath: %v", err)
	}
	if got != "/usr/bin/ffmpeg" {
		t.Errorf("got %q, want /usr/bin/ffmpeg", got)
	}
}

func TestResolveFfmpegPath_FallsBackToBareFfmpeg(t *testing.T) {
	calls := 0
	exec := ExecFunc(func(command string) (string, string, int, error) {
		calls++
		if contains(command, "'ffmpeg'") && !contains(command, "/ffmpeg") {
			return "SUPPORTED\n", "", 0, nil
		}
		return "UNSUPPORTED\n", "", 0, nil
	})
	got, err := ResolveFfmpegPath(exec)
	if err != nil {
		t.Fatalf("ResolveFfmpegPath: %v", err)
	}
	if got != "ffmpeg" {
		t.Errorf("got %q, want ffmpeg (PATH fallback)", got)
	}
	if calls != 4 {
		t.Errorf("expected all 4 candidates probed in order, got %d calls", calls)
	}
}

func TestResolveFfmpegPath_NoneSupported(t *testing.T) {
	exec := ExecFunc(func(command string) (string, string, int, error) {
		return "UNSUPPORTED\n", "", 0, nil
	})
	_, err := ResolveFfmpegPath(exec)
	if err == nil {
		t.Fatal("expected an error when no candidate supports x11grab")
	}
}

func TestResolveFfmpegPath_ProbeErrorSkipsCandidate(t *testing.T) {
	calls := 0
	exec := ExecFunc(func(command string) (string, string, int, error) {
		calls++
		if calls == 1 {
			return "", "", 0, fmt.Errorf("channel error")
		}
		if contains(command, "/usr/local/bin/ffmpeg") {
			return "SUPPORTED\n", "", 0, nil
		}
		return "UNSUPPORTED\n", "", 0, nil
	})
	got, err := ResolveFfmpegPath(exec)
	if err != nil {
		t.Fatalf("ResolveFfmpegPath: %v", err)
	}
	if got != "/usr/local/bin/ffmpeg" {
		t.Errorf("got %q, want /usr/local/bin/ffmpeg (second candidate, after a probe error on the first)", got)
	}
}

// This test specifically pins down the substring-containment bug documented
// on EnsureVirtualDisplay/ResolveFfmpegPath: a naive port using
// strings.Contains(stdout, "SUPPORTED") instead of exact-match would
// incorrectly treat "UNSUPPORTED" as a match. Exercised here by having the
// very first candidate report exactly "UNSUPPORTED\n" and asserting
// ResolveFfmpegPath correctly moves on rather than accepting it.
func TestResolveFfmpegPath_UnsupportedIsNotMistakenForSupported(t *testing.T) {
	exec := ExecFunc(func(command string) (string, string, int, error) {
		if contains(command, "/usr/bin/ffmpeg") {
			return "UNSUPPORTED\n", "", 0, nil
		}
		if contains(command, "/usr/local/bin/ffmpeg") {
			return "SUPPORTED\n", "", 0, nil
		}
		return "UNSUPPORTED\n", "", 0, nil
	})
	got, err := ResolveFfmpegPath(exec)
	if err != nil {
		t.Fatalf("ResolveFfmpegPath: %v", err)
	}
	if got != "/usr/local/bin/ffmpeg" {
		t.Errorf("got %q, want /usr/local/bin/ffmpeg", got)
	}
}

// --- EnsureVirtualDisplay -----------------------------------------------------

func TestEnsureVirtualDisplay_AlreadyRunning(t *testing.T) {
	exec := ExecFunc(func(command string) (string, string, int, error) {
		return "RUNNING\n", "", 0, nil
	})
	result, err := EnsureVirtualDisplay(exec, ":99")
	if err != nil {
		t.Fatalf("EnsureVirtualDisplay: %v", err)
	}
	if !result.AlreadyRunning {
		t.Error("expected AlreadyRunning = true")
	}
	if result.Display != ":99" {
		t.Errorf("Display = %q, want :99", result.Display)
	}
}

func TestEnsureVirtualDisplay_NotRunningIsNotMistakenForRunning(t *testing.T) {
	// Pins down the analogous RUNNING/NOTRUNNING substring-containment bug:
	// the check command's negative branch echoes "NOTRUNNING", which contains
	// "RUNNING" as a substring. A correct implementation must NOT treat that
	// as already-running.
	calls := 0
	exec := ExecFunc(func(command string) (string, string, int, error) {
		calls++
		if contains(command, "pgrep") {
			if calls == 1 {
				return "NOTRUNNING\n", "", 0, nil // first check: not running
			}
			return "RUNNING\n", "", 0, nil // confirm-after-start check
		}
		// the Xvfb-start command
		return "", "", 0, nil
	})
	result, err := EnsureVirtualDisplay(exec, ":99")
	if err != nil {
		t.Fatalf("EnsureVirtualDisplay: %v", err)
	}
	if result.AlreadyRunning {
		t.Error("expected AlreadyRunning = false: NOTRUNNING must not be mistaken for RUNNING")
	}
}

func TestEnsureVirtualDisplay_XvfbMissing(t *testing.T) {
	exec := ExecFunc(func(command string) (string, string, int, error) {
		if contains(command, "pgrep") {
			return "NOTRUNNING\n", "", 0, nil
		}
		return "", "XVFB_MISSING", 127, nil
	})
	_, err := EnsureVirtualDisplay(exec, ":99")
	if err == nil {
		t.Fatal("expected an error when Xvfb is not installed")
	}
}

func TestEnsureVirtualDisplay_DefaultsBlankDisplay(t *testing.T) {
	var sawCommand string
	exec := ExecFunc(func(command string) (string, string, int, error) {
		if contains(command, "pgrep") && sawCommand == "" {
			sawCommand = command
		}
		return "RUNNING\n", "", 0, nil
	})
	result, err := EnsureVirtualDisplay(exec, "  ")
	if err != nil {
		t.Fatalf("EnsureVirtualDisplay: %v", err)
	}
	if result.Display != DefaultDisplay {
		t.Errorf("Display = %q, want default %q", result.Display, DefaultDisplay)
	}
}

// --- ClassifyExit -------------------------------------------------------------

func TestClassifyExit(t *testing.T) {
	zero := 0
	nonZero := 1

	cases := []struct {
		name       string
		exitCode   *int
		stderrText string
		wantState  StreamState
	}{
		{"nil exit code", nil, "", StateStopped},
		{"zero exit code", &zero, "", StateStopped},
		{"non-zero with stderr", &nonZero, "some ffmpeg error", StateError},
		{"non-zero without stderr", &nonZero, "  ", StateError},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			state, message := ClassifyExit(tc.exitCode, tc.stderrText)
			if state != tc.wantState {
				t.Errorf("state = %v, want %v", state, tc.wantState)
			}
			if tc.wantState == StateError && message == "" {
				t.Error("expected a non-empty message for an error state")
			}
		})
	}
}

// --- StreamSession ------------------------------------------------------------

func TestStreamSession_RunDemuxesAndStop(t *testing.T) {
	frame := fakeFrame(7)
	stopped := false
	session := NewStreamSession(func() error {
		stopped = true
		return nil
	})

	var got [][]byte
	err := session.Run(newChunkReader(frame), func(f []byte, seq int) {
		got = append(got, f)
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(got) != 1 || !bytes.Equal(got[0], frame) {
		t.Fatalf("got %v frames, want [frame]", got)
	}

	if session.Stopped() {
		t.Error("Stopped() should be false before Stop() is called")
	}
	if err := session.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if !stopped {
		t.Error("expected the stop callback to run")
	}
	if !session.Stopped() {
		t.Error("Stopped() should be true after Stop()")
	}
}

func TestBuildExportDisplayCommandQuotesInput(t *testing.T) {
	display := ":0; touch /tmp/unexpected"
	want := "export DISPLAY=':0; touch /tmp/unexpected'\r"
	if got := BuildExportDisplayCommand(display); got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
