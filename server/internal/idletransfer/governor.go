// Package idletransfer implements the cooperative bandwidth governor and
// background media-cache/manual-download queue that replace
// IdleBandwidthGovernor/IdleTransferManager (src/main/idle-transfer.ts) for
// the Wails backend.
//
// Foreground SSH traffic (interactive file reads/writes, terminal activity,
// etc.) always wins: idle/background transfers stop getting any bandwidth
// allowance the instant foreground activity is noted, and only resume - at
// a throttled, ramping rate - once the connection has been quiet for a
// short period.
package idletransfer

import (
	"context"
	"math"
	"sync"
	"time"
)

// ForegroundQuietPeriod mirrors FOREGROUND_QUIET_PERIOD_MS in
// idle-transfer.ts: how long the connection must be free of foreground
// activity before background transfers get any bandwidth allowance at all.
const ForegroundQuietPeriod = 900 * time.Millisecond

// Rate tiers mirror the byte-per-second values inlined in
// waitForAllowance in idle-transfer.ts: the longer the connection stays
// quiet, the more bandwidth background transfers are allowed.
const (
	rateFloor   int64 = 256 * 1024      // < 3s quiet
	rateTier2   int64 = 1024 * 1024     // < 8s quiet
	rateTier3   int64 = 4 * 1024 * 1024 // < 20s quiet
	rateCeiling int64 = 8 * 1024 * 1024 // >= 20s quiet
)

const (
	quietTierBoundary1 = 3 * time.Second
	quietTierBoundary2 = 8 * time.Second
	quietTierBoundary3 = 20 * time.Second
)

// minPollInterval mirrors the `Math.max(25, ...)` floor on the "still
// inside the quiet period, check back later" sleep in waitForAllowance.
const minPollInterval = 25 * time.Millisecond

// sleepFunc is the seam tests use to make WaitForAllowance's loop run
// instantly and deterministically: instead of a real timer, a fake
// sleepFunc can advance the Governor's fake clock by d and return
// immediately, so a test can assert on the resulting rate tier without any
// wall-clock wait.
type sleepFunc func(ctx context.Context, d time.Duration) error

// Governor is the Go port of IdleBandwidthGovernor.
type Governor struct {
	mu             sync.Mutex
	foregroundOps  int
	lastForeground time.Time

	now   func() time.Time
	sleep sleepFunc
}

// NewGovernor creates a Governor using the real wall clock and a real timer.
func NewGovernor() *Governor {
	return &Governor{now: time.Now, sleep: realSleep, lastForeground: time.Now()}
}

func realSleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// BeginForeground marks a foreground operation as starting (mirrors
// beginForeground()): while any foreground operation is in flight,
// background transfers get no bandwidth allowance at all. The returned
// closure ends that operation; like the original, calling it more than once
// is a no-op after the first call, and both the begin and the end refresh
// the "last foreground activity" timestamp (so the quiet period restarts
// from when the operation *finished*, not just when it started).
func (g *Governor) BeginForeground() func() {
	g.mu.Lock()
	g.foregroundOps++
	g.lastForeground = g.now()
	g.mu.Unlock()

	var releaseOnce sync.Once
	return func() {
		releaseOnce.Do(func() {
			g.mu.Lock()
			if g.foregroundOps > 0 {
				g.foregroundOps--
			}
			g.lastForeground = g.now()
			g.mu.Unlock()
		})
	}
}

// NoteForegroundActivity mirrors noteForegroundActivity(): records that
// foreground activity just happened, without wrapping it in a begin/end
// pair (used for fire-and-forget signals like a terminal keystroke or
// tunnel byte).
func (g *Governor) NoteForegroundActivity() {
	g.mu.Lock()
	g.lastForeground = g.now()
	g.mu.Unlock()
}

type governorState struct {
	foregroundOps  int
	lastForeground time.Time
}

func (g *Governor) state() governorState {
	g.mu.Lock()
	defer g.mu.Unlock()
	return governorState{foregroundOps: g.foregroundOps, lastForeground: g.lastForeground}
}

// rateForQuietDuration mirrors the ternary chain in waitForAllowance that
// picks a bytes-per-second allowance from how long the connection has been
// quiet.
func rateForQuietDuration(quietFor time.Duration) int64 {
	switch {
	case quietFor < quietTierBoundary1:
		return rateFloor
	case quietFor < quietTierBoundary2:
		return rateTier2
	case quietFor < quietTierBoundary3:
		return rateTier3
	default:
		return rateCeiling
	}
}

// decide is the pure, directly-testable core of waitForAllowance: given the
// current time and governor state, it returns how long to sleep next and
// whether that sleep is a rate-limiting wait (after which, if the state is
// unchanged, the allowance is granted) as opposed to a "still inside the
// quiet period, poll again" wait (after which the loop always re-checks).
func decide(now time.Time, lastForeground time.Time, foregroundOps int, byteCount int) (sleep time.Duration, isRateWait bool) {
	quietFor := now.Sub(lastForeground)
	if foregroundOps == 0 && quietFor >= ForegroundQuietPeriod {
		rate := rateForQuietDuration(quietFor)
		seconds := float64(byteCount) / float64(rate)
		d := time.Duration(math.Ceil(seconds*1000)) * time.Millisecond
		if d < time.Millisecond {
			d = time.Millisecond
		}
		return d, true
	}

	remaining := ForegroundQuietPeriod - quietFor
	if remaining < minPollInterval {
		remaining = minPollInterval
	}
	return remaining, false
}

// WaitForAllowance blocks until byteCount bytes' worth of background
// transfer is allowed to proceed. Mirrors waitForAllowance(byteCount,
// signal) in idle-transfer.ts: it loops, sleeping either for the remainder
// of the quiet period or for the rate-limited pacing delay, and only
// returns once a full pacing sleep has elapsed with no foreground activity
// (begin, end, or note) in the meantime. Returns ctx.Err() if ctx is
// canceled while waiting.
func (g *Governor) WaitForAllowance(ctx context.Context, byteCount int) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		before := g.state()
		sleepDuration, isRateWait := decide(g.now(), before.lastForeground, before.foregroundOps, byteCount)
		if err := g.sleep(ctx, sleepDuration); err != nil {
			return err
		}

		if !isRateWait {
			continue
		}

		after := g.state()
		if after.foregroundOps == 0 && after.lastForeground.Equal(before.lastForeground) {
			return nil
		}
		// Foreground activity happened during the pacing sleep (mirrors the
		// original re-checking activityMarker after its delay): loop and
		// recompute from scratch.
	}
}
