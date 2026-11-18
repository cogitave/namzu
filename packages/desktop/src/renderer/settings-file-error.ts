/**
 * A broken settings file reaches Desktop as the engine's own sentence, written for the terminal:
 * "<file> isn't valid YAML (line 2, column 5). Fix it, then start Namzu again." In Desktop the
 * window re-reads the file (Try again, coming back into focus, a change on disk) and new
 * conversations read it fresh, so nothing needs a restart. Every page says it once, here, and
 * the parts that depend on the read say `SHOWN_WHEN_READABLE`.
 */

const TERMINAL_ADVICE = /\s*Fix it, then start Namzu again\.?\s*$/
const READ_PREFIX = /^\s*The configuration could not be read:\s*/

/** The sentence the engine says for a file it cannot parse or accept as settings. */
const FILE_PROBLEM = /\bisn['’]t valid (?:YAML|JSON)\b|\bmust be a set of named settings\b/

export const SHOWN_WHEN_READABLE = 'Shown once your settings can be read.'

export const FIX_IN_DESKTOP = 'Fix it and choose Try again.'

/** True when `text` is the engine's sentence about a settings file it could not read. */
export function isSettingsFileError(text: string | undefined): boolean {
	if (!text) return false
	const bare = text.replace(READ_PREFIX, '')
	return FILE_PROBLEM.test(bare) || TERMINAL_ADVICE.test(bare)
}

/** The engine's sentence with its terminal advice swapped for what to do in Desktop. */
export function desktopSettingsFileError(text: string): string {
	const bare = text.replace(READ_PREFIX, '').trim()
	const head = bare.replace(TERMINAL_ADVICE, '').replace(/[.\s]+$/, '')
	return `${head}. ${FIX_IN_DESKTOP}`
}
