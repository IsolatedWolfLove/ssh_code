// Package vision implements "vision mode" (a remote virtual X display
// captured via ffmpeg x11grab and streamed back as MJPEG frames) for the
// Wails backend, replacing the corresponding methods on SshSessionManager in
// src/main/ssh-session.ts (ensureVirtualDisplay, enableVisionMode,
// disableVisionMode, resolveFfmpegBinary, startVideoStream, stopVideoStream,
// drainVideoFrames).
//
// This package has no dependency on internal/ssh: every function that needs
// to run a command on the remote host accepts an injected ExecFunc, and
// StreamSession demuxes an already-started process's stdout (any io.Reader)
// rather than owning an SSH exec channel itself. The integration pass is
// expected to satisfy ExecFunc by wrapping internal/ssh.Session.ExecRemoteCommand
// and to supply StreamSession with the stdout/stderr of a real
// `client.NewSession()` + `Session.Start(ffmpegCommand)` exec.
package vision

import (
	"bytes"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"
)

// ExecFunc runs a one-off remote shell command, mirroring execRemoteCommand
// in ssh-session.ts, and reports its stdout/stderr/exit code.
type ExecFunc func(command string) (stdout string, stderr string, exitCode int, err error)

// DefaultDisplay mirrors VISION_DEFAULT_DISPLAY in ssh-session.ts.
const DefaultDisplay = ":99"

// ffmpegCandidatePaths mirrors FFMPEG_CANDIDATE_PATHS in ssh-session.ts:
// common distro-packaged ffmpeg install locations, checked before falling
// back to whatever `ffmpeg` resolves to on the remote user's PATH. This
// avoids silently picking up a conda/venv ffmpeg built without x11grab
// support (common with the conda-forge ffmpeg package), which would exit
// immediately with "Unknown input format: 'x11grab'" and produce no frames.
var ffmpegCandidatePaths = []string{"/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/bin/ffmpeg"}

// quoteForShell mirrors quoteForShell in src/main/shell.ts: single-quotes a
// value for safe inclusion in a remote shell command, escaping embedded
// single quotes.
func quoteForShell(value string) string {
	return "'" + strings.ReplaceAll(value, "'", `'\''`) + "'"
}

// sanitizeForLogFileName mirrors normalizedDisplay.replace(/[^\w]/g, ”):
// strips everything except ASCII letters/digits/underscore, used to build a
// safe log-file suffix from a display name like ":99".
func sanitizeForLogFileName(display string) string {
	var b strings.Builder
	for _, r := range display {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			b.WriteRune(r)
		}
	}
	return b.String()
}

// EnsureVirtualDisplayResult mirrors contracts.ts's EnsureVirtualDisplayResult.
type EnsureVirtualDisplayResult struct {
	Display        string
	AlreadyRunning bool
}

// EnsureVirtualDisplay mirrors ensureVirtualDisplay in ssh-session.ts:
// idempotently ensures an Xvfb virtual X display is running on the remote
// host at display (defaulting to DefaultDisplay when blank), starting it
// with `nohup Xvfb <display> -screen 0 1280x720x24 ... & disown` if it is
// not already running.
//
// Bug found and fixed while porting: the original's "already running" check
// is `check.stdout.includes('RUNNING')`, but the negative branch's output is
// the literal string "NOTRUNNING" - which itself contains "RUNNING" as a
// substring. So the original condition is true for BOTH outputs, meaning
// ensureVirtualDisplay always treats the display as already running and the
// Xvfb-starting branch is unreachable dead code. Same bug, same
// consequence, in resolveFfmpegBinary's "SUPPORTED"/"UNSUPPORTED" check
// below. This port fixes both by checking exact (trimmed) equality instead
// of substring containment, while keeping the exact same wire commands
// (still echoes literal RUNNING/NOTRUNNING and SUPPORTED/UNSUPPORTED) so
// behavior on the remote host is unchanged - only the Go-side interpretation
// of that output is corrected. Flagging prominently per the plan's Phase 4
// "precision over speed" instruction; not a judgment call I expect
// disagreement on, but worth a second pair of eyes given it changes
// observable behavior from the original app.
func EnsureVirtualDisplay(exec ExecFunc, display string) (EnsureVirtualDisplayResult, error) {
	normalized := strings.TrimSpace(display)
	if normalized == "" {
		normalized = DefaultDisplay
	}

	checkCommand := fmt.Sprintf(
		"pgrep -f %s >/dev/null 2>&1 && echo RUNNING || echo NOTRUNNING",
		quoteForShell("Xvfb "+normalized+" "),
	)

	stdout, _, _, err := exec(checkCommand)
	if err != nil {
		return EnsureVirtualDisplayResult{}, err
	}
	if strings.TrimSpace(stdout) == "RUNNING" {
		return EnsureVirtualDisplayResult{Display: normalized, AlreadyRunning: true}, nil
	}

	logSuffix := sanitizeForLogFileName(normalized)
	startCommand := strings.Join([]string{
		`command -v Xvfb >/dev/null 2>&1 || { echo "XVFB_MISSING" >&2; exit 127; }`,
		fmt.Sprintf("nohup Xvfb %s -screen 0 1280x720x24 >/tmp/sshstudio-xvfb-%s.log 2>&1 &", quoteForShell(normalized), logSuffix),
		"disown",
	}, "\n")

	_, startStderr, exitCode, err := exec(startCommand)
	if err != nil {
		return EnsureVirtualDisplayResult{}, err
	}
	if exitCode == 127 || strings.Contains(startStderr, "XVFB_MISSING") {
		return EnsureVirtualDisplayResult{}, fmt.Errorf("Xvfb is not installed on the remote host. Install it with: sudo apt install xvfb")
	}

	// Mirrors the 400ms `setTimeout` the original awaits inline before
	// confirming Xvfb bound its socket. EnsureVirtualDisplay is a
	// self-contained blocking operation in both versions, so owning the
	// sleep here (rather than pushing it onto the caller) matches the
	// original's structure.
	time.Sleep(400 * time.Millisecond)

	confirmStdout, _, _, err := exec(checkCommand)
	if err != nil {
		return EnsureVirtualDisplayResult{}, err
	}
	if strings.TrimSpace(confirmStdout) != "RUNNING" {
		return EnsureVirtualDisplayResult{}, fmt.Errorf("unable to start Xvfb on display %s", normalized)
	}

	return EnsureVirtualDisplayResult{Display: normalized, AlreadyRunning: false}, nil
}

// BuildExportDisplayCommand mirrors the `export DISPLAY=...\r` line
// enableVisionMode writes into every open plain-shell terminal. Wiring this
// into the live terminal registry (and the tmux/screen `setenv` variant for
// persistent sessions, via buildSetSessionEnvCommand in internal/terminal)
// is cross-package integration work left to the integration pass - this
// package only knows how to build the command string.
func BuildExportDisplayCommand(display string) string {
	return fmt.Sprintf("export DISPLAY=%s\r", quoteForShell(display))
}

// ResolveFfmpegPath mirrors resolveFfmpegBinary in ssh-session.ts: finds an
// ffmpeg binary on the remote host that actually supports the x11grab input
// device, checking ffmpegCandidatePaths before falling back to plain
// `ffmpeg` on PATH. See EnsureVirtualDisplay's doc comment for the
// SUPPORTED/UNSUPPORTED substring-containment bug this port fixes.
func ResolveFfmpegPath(exec ExecFunc) (string, error) {
	candidates := make([]string, 0, len(ffmpegCandidatePaths)+1)
	candidates = append(candidates, ffmpegCandidatePaths...)
	candidates = append(candidates, "ffmpeg")

	for _, candidate := range candidates {
		probeCommand := fmt.Sprintf(
			"command -v %s >/dev/null 2>&1 && %s -hide_banner -formats 2>&1 | grep -q x11grab && echo SUPPORTED || echo UNSUPPORTED",
			quoteForShell(candidate), quoteForShell(candidate),
		)
		stdout, _, _, err := exec(probeCommand)
		if err != nil {
			// Mirrors the original's `.catch(() => null)`: a probe failure
			// (e.g. the exec channel itself errors) is skipped, not fatal -
			// try the next candidate.
			continue
		}
		if strings.TrimSpace(stdout) == "SUPPORTED" {
			return candidate, nil
		}
	}

	return "", fmt.Errorf(
		"no ffmpeg with x11grab support was found on the remote host (checked /usr/bin, /usr/local/bin, /bin, and PATH). " +
			"If ffmpeg is only available inside a conda/venv environment, that build likely lacks x11grab support. " +
			"Install a distro package (e.g. `sudo apt install ffmpeg`) to enable vision mode.",
	)
}

// StreamOptions mirrors contracts.ts's StartVideoStreamInput, minus Display
// (passed separately to BuildFfmpegCommand since EnsureVirtualDisplay also
// needs a display independently of a running stream).
type StreamOptions struct {
	Width   int
	Height  int
	FPS     int
	Quality int
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// BuildFfmpegCommand mirrors the exact command construction inside
// startVideoStream in ssh-session.ts: an x11grab capture of display, encoded
// as MJPEG and written to stdout (`pipe:1`) so it can be streamed back over
// a plain SSH exec channel. Width/Height are floored at 1 (mirrors
// Math.max(1, Math.round(...)) - this Go signature takes ints, so any
// float->int rounding from a JSON-decoded request is the caller's
// responsibility); FPS is clamped to [1,60]; Quality is clamped to [2,31]
// (ffmpeg's mjpeg -q:v scale, where lower is higher quality).
func BuildFfmpegCommand(ffmpegBinary, display string, opts StreamOptions) string {
	width := opts.Width
	if width < 1 {
		width = 1
	}
	height := opts.Height
	if height < 1 {
		height = 1
	}
	size := fmt.Sprintf("%dx%d", width, height)
	fps := clamp(opts.FPS, 1, 60)
	quality := clamp(opts.Quality, 2, 31)

	return strings.Join([]string{
		fmt.Sprintf("%s -loglevel error", quoteForShell(ffmpegBinary)),
		fmt.Sprintf("-f x11grab -video_size %s -framerate %d -i %s", size, fps, quoteForShell(display)),
		fmt.Sprintf("-vf fps=%d", fps),
		fmt.Sprintf("-f mjpeg -q:v %d -threads 1", quality),
		"pipe:1",
	}, " ")
}

// soiMarker and eoiMarker are the JPEG Start-of-Image / End-of-Image byte
// markers (0xFFD8 / 0xFFD9) drainVideoFrames in ssh-session.ts scans for to
// split a raw MJPEG byte stream into individual frames. Confirmed from
// source: `const SOI = Buffer.from([0xff, 0xd8]); const EOI = Buffer.from([0xff, 0xd9]);`.
var (
	soiMarker = []byte{0xFF, 0xD8}
	eoiMarker = []byte{0xFF, 0xD9}
)

// DemuxMJPEG reads raw MJPEG bytes from r in chunks and calls onFrame once
// per complete frame (SOI through EOI, inclusive of both markers) with a
// 0-based, monotonically increasing sequence number. Mirrors
// drainVideoFrames in ssh-session.ts exactly, including its buffering
// behavior across chunk boundaries: when a SOI is found but no matching EOI
// yet, any bytes before that SOI are dropped and the (still-incomplete)
// frame-so-far is kept, awaiting more data; when NO SOI is found at all yet,
// the whole buffer (which may contain leading garbage) is left untouched
// rather than eagerly cleared - matching the original, which only trims up
// to a found SOI, never trims when indexOf(SOI) itself returns -1.
//
// Returns nil when r reaches io.EOF cleanly, or the first non-EOF error
// returned by r.
func DemuxMJPEG(r io.Reader, onFrame func(frame []byte, seq int)) error {
	var buffer []byte
	seq := 0
	chunk := make([]byte, 32*1024)

	for {
		n, err := r.Read(chunk)
		if n > 0 {
			buffer = append(buffer, chunk[:n]...)
			buffer, seq = drainFrames(buffer, seq, onFrame)
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// drainFrames mirrors drainVideoFrames's scanning loop body exactly, as a
// pure function of (buffer, seq) so it is directly testable without needing
// a real io.Reader to drive it chunk by chunk.
func drainFrames(buffer []byte, seq int, onFrame func(frame []byte, seq int)) ([]byte, int) {
	start := bytes.Index(buffer, soiMarker)
	for start != -1 {
		end := indexFrom(buffer, eoiMarker, start+len(soiMarker))
		if end == -1 {
			// Incomplete frame: drop any garbage before the current SOI and
			// wait for more data.
			if start > 0 {
				buffer = buffer[start:]
			}
			return buffer, seq
		}

		frameEnd := end + len(eoiMarker)
		frame := buffer[start:frameEnd]
		// Copy out: buffer's backing array is reused/reallocated by the
		// next append in DemuxMJPEG's loop, so onFrame must not retain a
		// slice into it.
		frameCopy := make([]byte, len(frame))
		copy(frameCopy, frame)
		onFrame(frameCopy, seq)
		seq++

		buffer = buffer[frameEnd:]
		start = bytes.Index(buffer, soiMarker)
	}
	return buffer, seq
}

// indexFrom mirrors Buffer.indexOf(needle, fromIndex): finds needle in
// haystack starting the search at position from, or -1 if from is already
// past the end of haystack or needle is not found.
func indexFrom(haystack, needle []byte, from int) int {
	if from >= len(haystack) {
		return -1
	}
	idx := bytes.Index(haystack[from:], needle)
	if idx == -1 {
		return -1
	}
	return idx + from
}

// StreamState mirrors contracts.ts's VideoStreamStateEvent.status.
type StreamState string

const (
	StateRunning StreamState = "running"
	StateStopped StreamState = "stopped"
	StateError   StreamState = "error"
)

// ClassifyExit mirrors the classification inside startVideoStream's
// `channel.on('close', exitCode)` handler in ssh-session.ts: exitCode nil
// (mirrors the original's `exitCode === null`, e.g. a signal-terminated
// process) or 0 is reported as 'stopped'; any other exit code is reported as
// 'error', with stderrText (trimmed) as the message, or a generic
// "ffmpeg exited with code N" message when stderrText is empty.
func ClassifyExit(exitCode *int, stderrText string) (state StreamState, message string) {
	if exitCode == nil || *exitCode == 0 {
		return StateStopped, ""
	}
	msg := strings.TrimSpace(stderrText)
	if msg == "" {
		msg = fmt.Sprintf("ffmpeg exited with code %d", *exitCode)
	}
	return StateError, msg
}

// StreamSession wraps demuxing an already-started ffmpeg process's stdout
// into frames, plus minimal stop bookkeeping. It owns no SSH/exec-channel
// logic itself (see the package doc comment) - Run demuxes whatever
// io.Reader the caller supplies, and Stop calls the caller-supplied
// teardown callback (e.g. closing the underlying SSH channel), mirroring
// stopVideoStream's destroyChannel(session.channel) call.
type StreamSession struct {
	stop func() error

	mu      sync.Mutex
	stopped bool
}

// NewStreamSession constructs a StreamSession. stop tears down whatever
// process/channel is feeding the io.Reader later passed to Run (e.g. close
// an SSH exec channel); it may be nil if the caller has nothing to do beyond
// letting Run's read loop observe EOF naturally.
func NewStreamSession(stop func() error) *StreamSession {
	return &StreamSession{stop: stop}
}

// Run demuxes stdout via DemuxMJPEG, calling onFrame per complete frame.
// Returns when stdout reaches EOF or errors; the caller is expected to
// separately observe the underlying process's actual exit status (e.g. an
// SSH channel's 'exit-status' request) and call ClassifyExit itself to
// decide the final 'stopped'/'error' state - this package has no visibility
// into process exit codes, only the byte stream.
func (s *StreamSession) Run(stdout io.Reader, onFrame func(frame []byte, seq int)) error {
	return DemuxMJPEG(stdout, onFrame)
}

// Stop marks the session as intentionally stopped and invokes the
// caller-supplied teardown callback.
func (s *StreamSession) Stop() error {
	s.mu.Lock()
	s.stopped = true
	s.mu.Unlock()

	if s.stop != nil {
		return s.stop()
	}
	return nil
}

// Stopped reports whether Stop has been called.
func (s *StreamSession) Stopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}
