// Patterns the authorization gate's `deny_dangerous_patterns` rule
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
	/**
	 * Fork bomb.
	 *
	 * The previous entry was `/:(){ :\|:& };:/`, which could not match one. In
	 * a regular expression `()` is an empty capture group, not two literal
	 * parentheses, so that pattern described the string `:{ :|:& };:` — which
	 * is not valid shell and which nobody would ever type. Probed: it returned
	 * false for `:(){ :|:& };:` and every spelling of it, while `run.ts`'s own
	 * docstring promised "the safety gate still hard-denies catastrophic
	 * commands".
	 *
	 * Matched on SELF-REFERENCE rather than on one literal spelling: a fork
	 * bomb is a function whose own name appears on both sides of a pipe, is
	 * backgrounded, and is then invoked. That is what separates it from a
	 * function that merely contains a pipe — `watch(){ tail -f log | grep E & }`
	 * does not match, and `bomb(){ bomb|bomb& }; bomb` does.
	 *
	 * EVERY run is bounded, not just the name. The first version bounded the
	 * name and left the gaps as `\s*`, and static analysis caught what a hand
	 * probe did not: a chain of unbounded runs backtracks polynomially, and
	 * this list is matched against SERIALIZED TOOL INPUT — model output, which
	 * a prompt injection can shape. A denial of service in the check that
	 * exists to prevent one is the wrong way round.
	 *
	 * `[ \t]` rather than `\s`, because a shell function definition of this
	 * shape lives on one line, and the bound is generous for real spacing.
	 */
	/([\w.]{1,32}|:)[ \t]{0,8}\([ \t]{0,8}\)[ \t]{0,8}\{[ \t]{0,8}\1[ \t]{0,8}\|[ \t]{0,8}\1[ \t]{0,8}&[ \t]{0,8};?[ \t]{0,8}\}[ \t]{0,8};?[ \t]{0,8}\1/,
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

export const FILESYSTEM_TOOLS = new Set(['glob', 'read', 'write', 'bash'])

/**
 * Subdirectory of a run directory holding tool output that exceeded the
 * model-visible budget. Kept beside the run so it is cleaned up with the
 * run and reachable by the agent through its own `read`/`grep`.
 */
export const TOOL_OUTPUT_DIR_NAME = 'tool-output'

/**
 * Turns the loop will spend asking again for a valid structured output
 * before giving up with `stop_reason: 'structured_output_failed'`.
 *
 * Bounded on purpose: a model that cannot satisfy the schema should fail
 * loudly and cheaply, not iterate against `maxIterations`.
 */
export const DEFAULT_STRUCTURED_OUTPUT_RETRIES = 2

/** What the loop sends when the model tries to finish in prose instead. */
export const STRUCTURED_OUTPUT_REPROMPT =
	'[SYSTEM] This task requires a structured result. Call the `structured_output` tool with your final answer, matching its schema exactly. Do not answer in prose.'
