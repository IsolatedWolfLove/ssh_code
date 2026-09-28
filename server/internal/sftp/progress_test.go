package sftp

import (
	"testing"
	"time"
)

func TestRateEstimatorBytesPerSecond(t *testing.T) {
	r := NewRateEstimator()

	if _, ok := r.BytesPerSecond(); ok {
		t.Error("expected no rate before any samples")
	}

	base := time.Now()
	r.Record(0, base)
	if _, ok := r.BytesPerSecond(); ok {
		t.Error("expected no rate after a single sample")
	}

	r.Record(1000, base.Add(1*time.Second))
	rate, ok := r.BytesPerSecond()
	if !ok {
		t.Fatal("expected a measurable rate after two samples")
	}
	if rate < 999 || rate > 1001 {
		t.Errorf("BytesPerSecond() = %v, want ~1000", rate)
	}
}

func TestRateEstimatorEtaSeconds(t *testing.T) {
	r := NewRateEstimator()
	base := time.Now()
	r.Record(0, base)
	r.Record(1000, base.Add(1*time.Second))

	eta, ok := r.EtaSeconds(1000, 5000)
	if !ok {
		t.Fatal("expected a measurable ETA")
	}
	if eta < 3.9 || eta > 4.1 {
		t.Errorf("EtaSeconds(1000, 5000) = %v, want ~4", eta)
	}

	eta, ok = r.EtaSeconds(5000, 5000)
	if !ok || eta != 0 {
		t.Errorf("EtaSeconds at completion = (%v, %v), want (0, true)", eta, ok)
	}
}

func TestRateEstimatorEvictsOldSamples(t *testing.T) {
	r := NewRateEstimator()
	base := time.Now()

	// More than maxSamples (8) records; only the most recent should survive.
	for i := 0; i <= 10; i++ {
		r.Record(int64(i*100), base.Add(time.Duration(i)*time.Millisecond))
	}

	rate, ok := r.BytesPerSecond()
	if !ok {
		t.Fatal("expected a measurable rate")
	}
	if rate <= 0 {
		t.Errorf("BytesPerSecond() = %v, want > 0", rate)
	}
}

func TestThrottledEmitterRespectsWindow(t *testing.T) {
	calls := 0
	emitter := NewThrottledEmitter(func() { calls++ })

	emitter.MaybeEmit(false)
	if calls != 1 {
		t.Fatalf("expected the first MaybeEmit to fire immediately, calls = %d", calls)
	}

	emitter.MaybeEmit(false)
	if calls != 1 {
		t.Errorf("expected a second immediate call within the throttle window to be suppressed, calls = %d", calls)
	}

	emitter.MaybeEmit(true)
	if calls != 2 {
		t.Errorf("expected force=true to bypass the throttle, calls = %d", calls)
	}
}
