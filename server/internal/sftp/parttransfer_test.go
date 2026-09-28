package sftp

import "testing"

func TestPartPathHelpers(t *testing.T) {
	const original = "/remote/data.bin"
	part := ToPartPath(original)

	if !IsPartPath(part) {
		t.Errorf("IsPartPath(%q) = false, want true", part)
	}
	if IsPartPath(original) {
		t.Errorf("IsPartPath(%q) = true, want false", original)
	}
	if got := FinalFromPart(part); got != original {
		t.Errorf("FinalFromPart(%q) = %q, want %q", part, got, original)
	}
	if got := FinalFromPart(original); got != original {
		t.Errorf("FinalFromPart(%q) = %q, want %q (no-op on non-part paths)", original, got, original)
	}
}

func TestResolveResumeOffset(t *testing.T) {
	cases := []struct {
		name       string
		partSize   int64
		hasPart    bool
		sourceSize int64
		want       int64
	}{
		{"no existing part", 0, false, 1000, 0},
		{"part smaller than source resumes", 400, true, 1000, 400},
		{"part equal to source restarts", 1000, true, 1000, 0},
		{"part larger than source restarts (stale)", 1500, true, 1000, 0},
		{"zero-size part restarts", 0, true, 1000, 0},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := ResolveResumeOffset(tc.partSize, tc.hasPart, tc.sourceSize)
			if got != tc.want {
				t.Errorf("ResolveResumeOffset(%d, %v, %d) = %d, want %d", tc.partSize, tc.hasPart, tc.sourceSize, got, tc.want)
			}
		})
	}
}
