package sftp

import (
	"sync"
	"time"
)

// TransferProgressThrottle mirrors TRANSFER_PROGRESS_THROTTLE_MS: byte-progress
// events would otherwise fire on every chunk (thousands per second on a fast
// link). Throttle emission to a rate the UI can actually paint; callers should
// always force-emit the final state for a file regardless of the throttle.
const TransferProgressThrottle = 250 * time.Millisecond

type rateSample struct {
	at    time.Time
	bytes int64
}

// RateEstimator is a sliding-window transfer-rate estimator. Samples older
// than windowMs (or beyond maxSamples) are dropped, so the reported rate
// tracks recent throughput rather than a lifetime average that lags after a
// stall. Ported from src/main/transfer.ts's RateEstimator.
type RateEstimator struct {
	mu         sync.Mutex
	samples    []rateSample
	windowSize time.Duration
	maxSamples int
}

// NewRateEstimator creates an estimator with the same defaults as the
// TypeScript original (3s window, 8 samples).
func NewRateEstimator() *RateEstimator {
	return &RateEstimator{
		windowSize: 3 * time.Second,
		maxSamples: 8,
	}
}

// Record adds a new (totalBytes, at) sample and evicts stale entries.
func (r *RateEstimator) Record(totalBytes int64, at time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()

	r.samples = append(r.samples, rateSample{at: at, bytes: totalBytes})
	cutoff := at.Add(-r.windowSize)
	for len(r.samples) > r.maxSamples || (len(r.samples) > 1 && r.samples[0].at.Before(cutoff)) {
		r.samples = r.samples[1:]
	}
}

// BytesPerSecond returns bytes per second across the current window, or ok=false
// until measurable.
func (r *RateEstimator) BytesPerSecond() (float64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.bytesPerSecondLocked()
}

func (r *RateEstimator) bytesPerSecondLocked() (float64, bool) {
	if len(r.samples) < 2 {
		return 0, false
	}

	first := r.samples[0]
	last := r.samples[len(r.samples)-1]
	elapsed := last.at.Sub(first.at)
	deltaBytes := last.bytes - first.bytes
	if elapsed <= 0 || deltaBytes <= 0 {
		return 0, false
	}

	return float64(deltaBytes) / elapsed.Seconds(), true
}

// EtaSeconds returns seconds until totalBytes is reached at the current rate,
// or ok=false if unknown.
func (r *RateEstimator) EtaSeconds(transferredBytes, totalBytes int64) (float64, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	rate, ok := r.bytesPerSecondLocked()
	if !ok || rate <= 0 {
		return 0, false
	}

	remaining := totalBytes - transferredBytes
	if remaining <= 0 {
		return 0, true
	}

	return float64(remaining) / rate, true
}

// ThrottledEmitter wraps a callback so it only fires at most once per
// TransferProgressThrottle, unless forced. Mirrors the emitByteProgress
// throttling logic in ssh-session.ts.
type ThrottledEmitter struct {
	mu         sync.Mutex
	lastEmitAt time.Time
	emit       func()
}

// NewThrottledEmitter creates an emitter that calls emit via MaybeEmit.
func NewThrottledEmitter(emit func()) *ThrottledEmitter {
	return &ThrottledEmitter{emit: emit}
}

// MaybeEmit calls the wrapped callback if force is true or the throttle
// window has elapsed since the last emission.
func (t *ThrottledEmitter) MaybeEmit(force bool) {
	t.mu.Lock()
	now := time.Now()
	if !force && now.Sub(t.lastEmitAt) < TransferProgressThrottle {
		t.mu.Unlock()
		return
	}
	t.lastEmitAt = now
	t.mu.Unlock()
	t.emit()
}
