// Patterns the verification gate's `deny_dangerous_patterns` rule
// matches against the JSON-serialised tool input. The list is
// intentionally short and high-signal: the goal is to catch the
// canonical "I will brick the host" mistakes (filesystem wipes,
// disk reformat, fork bomb) plus the most common shell-side
// privilege/escape patterns (root sudo, world-writable chmod, the
// classic curl|bash / wget|bash exfil-then-exec pipe, raw eval).
//
// This is NOT a security boundary — Cursor learned the hard way
// that bash denylists are bypassed via shell tricks like `e""cho`
// (see Backslash Security 2025). Sandbox enforcement (FS isolation,
// network egress proxy) is the real boundary; these patterns only
// catch the most blatant attempts and turn them into an explicit
// review prompt instead of a silent execute.
export const DANGEROUS_PATTERNS = [
	// Filesystem wipe / fork bomb / raw disk write.
	/rm\s+-rf\s+\//,
	/mkfs/,
	/dd\s+if=/,
	/:(){ :\|:& };:/,
	// Privilege escalation + world-writable chmod on /.
	/\bsudo\b/,
	/\bsu\s+-/,
	/chmod\s+(?:-R\s+)?777\s+\//,
	// Pipe-to-shell from network — exfil-then-exec staging.
	/\bcurl\b[^|]*\|\s*(?:sh|bash|zsh)\b/,
	/\bwget\b[^|]*\|\s*(?:sh|bash|zsh)\b/,
	// Remote shell / outbound SSH.
	/\bssh\s+\S+@/,
	// Raw eval of dynamic strings.
	/\beval\s+["'`$]/,
]

export const FILESYSTEM_TOOLS = new Set(['Glob', 'Read', 'Write', 'Bash'])
