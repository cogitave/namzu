/**
 * The one Node warning the terminal never shows.
 *
 * Node 22 prints `(node:1234) ExperimentalWarning: SQLite is an experimental
 * feature and might change at any time` the first time `node:sqlite` loads,
 * above the banner, and a person reads it as Namzu being unsure of itself. The
 * session index uses `node:sqlite` on purpose (and falls back to a scan where
 * it does not load), so the notice tells nobody anything they can act on.
 *
 * Exactly that warning is dropped, and only that one: the type must be
 * `ExperimentalWarning` and the text must be Node's own sentence about SQLite.
 * Any other warning, including every other experimental feature, still prints.
 *
 * This is installed by importing the module first in each entry (`bin.ts`),
 * before anything can load `node:sqlite`; ESM evaluates imports in order, so a
 * side-effect import at the top is earlier than any import below it.
 */

const SQLITE_EXPERIMENTAL = /^SQLite is an experimental feature\b/

type EmitWarning = typeof process.emitWarning

interface WarningTarget {
	emitWarning: EmitWarning
}

/** Whether these `emitWarning` arguments are Node's SQLite experimental notice. */
export function isSqliteExperimentalWarning(warning: unknown, rest: readonly unknown[]): boolean {
	const message =
		typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : undefined
	if (message === undefined || !SQLITE_EXPERIMENTAL.test(message)) return false
	const first = rest[0]
	const type =
		typeof first === 'string'
			? first
			: typeof first === 'object' && first !== null && 'type' in first
				? (first as { type?: unknown }).type
				: warning instanceof Error
					? warning.name
					: undefined
	return type === 'ExperimentalWarning'
}

/**
 * Wrap `target.emitWarning` so the SQLite notice is dropped. Returns a function
 * that puts the original back; calling it twice is harmless.
 */
export function suppressSqliteExperimentalWarning(
	target: WarningTarget = process as unknown as WarningTarget,
): () => void {
	const original = target.emitWarning
	const filtered = function (this: unknown, warning: unknown, ...rest: unknown[]): void {
		if (isSqliteExperimentalWarning(warning, rest)) return
		;(original as (...args: unknown[]) => void).call(target, warning, ...rest)
	} as EmitWarning
	target.emitWarning = filtered
	return () => {
		if (target.emitWarning === filtered) target.emitWarning = original
	}
}

suppressSqliteExperimentalWarning()
