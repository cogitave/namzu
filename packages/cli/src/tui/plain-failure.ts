import { homePath } from './person-terms.js'
import { debugRequested } from './plain-interruption.js'

/**
 * One sentence for a failure the app itself hit (not a provider's), so an
 * error object is never pasted after a colon. Known causes map to plain
 * words; everything else says what could not be done, and points at
 * `--debug` for the technical text.
 */
/**
 * A refusal whose message is already the sentence for a person (startup wrote it
 * through `explainFailure` itself), so wrapping it again keeps it whole instead of
 * hiding it behind `--debug`.
 */
export class StartupRefusal extends Error {
	override readonly name = 'StartupRefusal'
}

/** Whether an error is machine output (a system code or a built-in type), never a sentence for a person. */
export function isMachineError(err: unknown): boolean {
	return !(err instanceof Error) || BUILT_IN_ERRORS.has(err.name) || codeOf(err) !== undefined
}

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
	if (err instanceof StartupRefusal) return `${couldNot} ${err.message}`
	// A sentence Namzu itself wrote for a person ("Delegated agents are still
	// active; ...") is shown as it is; anything that reads as machine output is not.
	if (err instanceof Error && isAuthoredSentence(err)) return `${couldNot} ${err.message}`
	if (debug && err instanceof Error && err.message)
		return `${couldNot} Details: ${err.message}${/[.!?]$/.test(err.message) ? '' : '.'}`
	return `${couldNot} Run with --debug for details.`
}

/** The sentence for a working directory Namzu cannot start in; the folder is written with `~`. */
export function workingDirectoryProblem(
	path: string,
	err: unknown,
	debug: boolean = debugRequested(),
): string {
	const couldNot = `Namzu could not open the folder ${homePath(path)}.`
	const code = codeOf(err)
	if (code === 'ENOENT' || code === 'ENOTDIR') {
		return `${couldNot} It does not exist. Check the path, then try again.`
	}
	if (code === 'EACCES' || code === 'EPERM') {
		return `${couldNot} Namzu does not have permission to read it. Choose another folder.`
	}
	return `${explainFailure(err, couldNot, debug)} Choose another folder.`
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
