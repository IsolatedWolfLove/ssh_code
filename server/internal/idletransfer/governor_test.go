package idletransfer

import (
	"context"
	"testing"
	"time"
)

// fakeClock lets tests advance time deterministically instead of relying on
// real sleeps.
type fakeClock struct {
	t time.Time
}

func (c *fakeClock) now() time.Time          { return c.t }
func (c *fakeClock) advance(d time.Duration) { c.t = c.t.Add(d) }

// newTestGovernor builds a Governor whose `now` reads from clock and whose
// `sleep` advances clock by d instead of actually blocking, so the ramp
// curve can be exercised instantly.
func newTestGovernor(clock *fakeClock) *Governor {
	return &Governor{
		now:            clock.now,
		lastForeground: clock.now(),
		sleep: func(_ context.Context, d time.Duration) error {
			clock.advance(d)
			return nil
		},
	}
}

func TestRateForQuietDuration(t *testing.T) {
	cases := []struct {
		quiet time.Duration
		want  int64
	}{
		{0, rateFloor},
		{2999 * time.Millisecond, rateFloor},
		{3 * time.Second, rateTier2},
		{7999 * time.Millisecond, rateTier2},
		{8 * time.Second, rateTier3},
		{19999 * time.Millisecond, rateTier3},
		{20 * time.Second, rateCeiling},
		{time.Hour, rateCeiling},
	}
	for _, tc := range cases {
		if got := rateForQuietDuration(tc.quiet); got != tc.want {
			t.Errorf("rateForQuietDuration(%v) = %d, want %d", tc.quiet, got, tc.want)
		}
	}
}

func TestWaitForAllowance_FloorRateImmediatelyAfterForeground(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	g := newTestGovernor(clock)

	release := g.BeginForeground()
	release()

	// Right after release, quietFor is ~0 (clock hasn't advanced), so the
	// first pass should be a "still in quiet period" wait, then a floor-rate
	// wait once the quiet period elapses - never jumping straight to a
	// higher tier.
	start := clock.t
	if err := g.WaitForAllowance(context.Background(), int(rateFloor)); err != nil {
		t.Fatalf("WaitForAllowance: %v", err)
	}
	elapsed := clock.t.Sub(start)

	// Expect roughly ForegroundQuietPeriod (poll to become quiet) + 1s worth
	// of floor-rate pacing for rateFloor bytes.
	wantMin := ForegroundQuietPeriod + 900*time.Millisecond
	wantMax := ForegroundQuietPeriod + 1100*time.Millisecond
	if elapsed < wantMin || elapsed > wantMax {
		t.Errorf("elapsed = %v, want between %v and %v (floor-rate pacing)", elapsed, wantMin, wantMax)
	}
}

func TestWaitForAllowance_RampsUpWhenQuietLonger(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	g := newTestGovernor(clock)
	g.lastForeground = clock.t.Add(-10 * time.Second) // already quiet for 10s

	start := clock.t
	if err := g.WaitForAllowance(context.Background(), int(rateTier3)); err != nil {
		t.Fatalf("WaitForAllowance: %v", err)
	}
	elapsed := clock.t.Sub(start)

	// 10s quiet -> rateTier3 (4 MiB/s) tier: rateTier3 bytes should take ~1s,
	// not ~32s (which is what the floor rate would imply).
	if elapsed > 1100*time.Millisecond {
		t.Errorf("elapsed = %v, want ~1s (rateTier3 tier), governor did not ramp up", elapsed)
	}
}

func TestWaitForAllowance_ForegroundDuringPacingRestartsWait(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	g := newTestGovernor(clock)
	g.lastForeground = clock.t.Add(-30 * time.Second) // quiet, at ceiling tier

	callCount := 0
	g.sleep = func(_ context.Context, d time.Duration) error {
		callCount++
		clock.advance(d)
		if callCount == 1 {
			// Simulate foreground activity landing mid-pacing-sleep.
			g.mu.Lock()
			g.lastForeground = clock.t
			g.mu.Unlock()
		}
		return nil
	}

	if err := g.WaitForAllowance(context.Background(), int(rateCeiling)); err != nil {
		t.Fatalf("WaitForAllowance: %v", err)
	}

	// Must have looped at least twice: once where activity was detected
	// after the sleep (so the wait was NOT granted), and at least once more
	// to actually grant it.
	if callCount < 2 {
		t.Errorf("callCount = %d, want >= 2 (foreground activity must restart the wait)", callCount)
	}
}

func TestBeginForeground_ReleaseIsIdempotent(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	g := newTestGovernor(clock)

	release := g.BeginForeground()
	release()
	release() // must not double-decrement foregroundOps below 0

	g.mu.Lock()
	ops := g.foregroundOps
	g.mu.Unlock()
	if ops != 0 {
		t.Errorf("foregroundOps = %d, want 0 after idempotent release", ops)
	}
}

func TestWaitForAllowance_ContextCanceled(t *testing.T) {
	clock := &fakeClock{t: time.Unix(0, 0)}
	g := newTestGovernor(clock)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if err := g.WaitForAllowance(ctx, 1); err == nil {
		t.Error("WaitForAllowance with a canceled context should return an error")
	}
}
