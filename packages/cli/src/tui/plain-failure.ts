import { debugRequested } from './plain-interruption.js'

/**
 * One sentence for a failure the app itself hit (not a provider's), so an
 * error object is never pasted after a colon. Known causes map to plain
 * words; everything else says what could not be done, and points at
 * `--debug` for the technical text.
 */
export function explainFailure(
	err: unknown,
	couldNot: string,
	debug: boolean = debugRequested(),
): string {
	const code = codeOf(err)
	const name = err instanceof Error ? err.name : ''
	let cause: string | undefined
	if (code === 'EACCES' || code === 'EPERM') {
		cause = 'Namzu does not have permission to write its files.'
	} else if (code === 'ENOSPC') {
		cause = 'The disk is full.'
	} else if (code === 'ENOENT') {
		cause = 'A file Namzu needs is missing.'
	} else if (code === 'EROFS') {
		cause = 'The folder is read-only.'
	} else if (name === 'TurnInProgressError') {
		cause = 'Another reply is still running in this conversation.'
	} else if (name === 'AbortError') {
		cause = 'It was stopped.'
	}
	if (cause) return `${couldNot} ${cause}`
	// A sentence Namzu itself wrote for a person ("Delegated agents are still
	// active; ...") is shown as it is; anything that reads as machine output is not.
	if (err instanceof Error && isAuthoredSentence(err)) return `${couldNot} ${err.message}`
	const detail = debug && err instanceof Error && err.message ? ` (${err.message})` : ''
	return `${couldNot} Run with --debug for details.${detail}`
}

function codeOf(err: unknown): string | undefined {
	if (err && typeof err === 'object' && 'code' in err) {
		const code = (err as { code?: unknown }).code
		return typeof code === 'string' ? code : undefined
	}
	return undefined
}

const BUILT_IN_ERRORS = new Set([
	'TypeError',
	'RangeError',
	'SyntaxError',
	'ReferenceError',
	'URIError',
	'EvalError',
	'AggregateError',
])

/**
 * Whether an error's message is a finished sentence meant for a person, not
 * machine output: a plain `Error` without a system code, a capital letter and a
 * full stop, one line, no paths, JSON, stack frames or `undefined`. The test is
 * deliberately strict; a message that fails it is hidden behind `--debug`.
 */
export function isAuthoredSentence(err: Error): boolean {
	if (BUILT_IN_ERRORS.has(err.name) || codeOf(err) !== undefined) return false
	const text = err.message
	if (text.length < 8 || text.length > 220) return false
	if (!/^[A-Z]/.test(text) || !/[.!?]$/.test(text)) return false
	if (
		/[\n\r{}[\]\\]|\w\/\w|~\/|\/\w+\/|\bat \S+:\d+|\b(undefined|null|NaN)\b|\b[A-Z_]{4,}\b/.test(
			text,
		)
	)
		return false
	return true
}
