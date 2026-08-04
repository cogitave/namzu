/**
 * One matcher for Claude model ids, because there were three.
 *
 * Two provider packages and one capability table each carried their own copy
 * of the same regular expression, and all three were wrong in the same way:
 * the minor-version group was `(\d+)`, which happily swallowed the 8-digit
 * date suffix. Probed against the shipped pattern:
 *
 * ```
 * claude-sonnet-4-20250514   -> major=4  minor=20250514
 * claude-opus-4-1-20250805   -> major=4  minor=1
 * ```
 *
 * A dated id that names no minor version therefore compared as enormously
 * NEWER than one that does, and every capability decision keyed on
 * `minor >= n` inverted for exactly those ids — the model was told it
 * supported features it does not.
 *
 * A real minor version is one to three digits; a date is exactly eight. Making
 * the group `\d{1,3}` is what stops it reaching across the separator, and the
 * regex then backtracks into leaving `minor` absent so the date suffix can
 * match where it belongs.
 */

export type ClaudeFamily = 'haiku' | 'sonnet' | 'opus' | 'fable' | 'mythos'

export interface ClaudeModelVersion {
	readonly family: ClaudeFamily
	readonly major: number
	/** `0` when the id names no minor — `claude-opus-5` is 5.0. */
	readonly minor: number
}

/**
 * `\d{1,3}` on the minor, not `\d+`. That single bound is the fix; the rest
 * matches what it always did.
 */
const CLAUDE_MODEL_ID =
	/^(?:anthropic\/)?claude-(haiku|sonnet|opus|fable|mythos)-(\d+)(?:[-_.](\d{1,3}))?(?:-\d{8})?$/

/** `undefined` for anything this does not recognise — never a guess. */
export function parseClaudeModelVersion(model: string): ClaudeModelVersion | undefined {
	const match = model.toLowerCase().match(CLAUDE_MODEL_ID)
	if (!match) return undefined
	return {
		family: match[1] as ClaudeFamily,
		major: Number(match[2]),
		minor: match[3] === undefined ? 0 : Number(match[3]),
	}
}

/**
 * Whether a model id names a version at or above `major.minor`.
 *
 * The comparison every caller was writing by hand. An id this cannot parse
 * returns `false`: a capability gate must not open for a name it does not
 * understand, which is the fail-safe reading and the one the callers'
 * own comments already claimed.
 */
export function claudeVersionAtLeast(model: string, major: number, minor: number): boolean {
	const version = parseClaudeModelVersion(model)
	if (!version) return false
	return version.major > major || (version.major === major && version.minor >= minor)
}
