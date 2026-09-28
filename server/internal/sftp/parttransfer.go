package sftp

// PartSuffix is a control-char-free suffix that is unlikely to collide with a
// real file and is easy to filter out of directory listings. Ported from
// src/main/transfer.ts's PART_SUFFIX.
const PartSuffix = ".sshstudio-part"

// IsPartPath reports whether path ends with the resumable-transfer suffix.
func IsPartPath(path string) bool {
	return len(path) >= len(PartSuffix) && path[len(path)-len(PartSuffix):] == PartSuffix
}

// ToPartPath appends the resumable-transfer suffix to path.
func ToPartPath(path string) string {
	return path + PartSuffix
}

// FinalFromPart strips the resumable-transfer suffix from path, if present.
func FinalFromPart(path string) string {
	if IsPartPath(path) {
		return path[:len(path)-len(PartSuffix)]
	}
	return path
}

// ResolveResumeOffset decides where a resumable transfer should continue
// from. Ported from src/main/transfer.ts's resolveResumeOffset.
//
//   - No existing part (hasPart == false) -> start at 0.
//   - Part already as large as (or larger than) the source -> it is stale or
//     complete; discarding and restarting is safer than trusting a
//     mismatched tail, so return 0 and let the caller truncate.
//   - Otherwise resume from the end of the part.
func ResolveResumeOffset(partSize int64, hasPart bool, sourceSize int64) int64 {
	if !hasPart || partSize <= 0 {
		return 0
	}
	if partSize >= sourceSize {
		return 0
	}
	return partSize
}
