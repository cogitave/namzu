import { plainError } from '../shared/plain-error.js'

/**
 * The text of a native error box. The box never shows the raw error up front: a sentence a person
 * can act on comes first, and the original sits under "Details" for the support folder.
 */
export function nativeFailureBody(error: unknown, whatFailed: 'start' | 'stop'): string {
	const raw = error instanceof Error ? error.message : String(error)
	const known = plainError(raw)
	// An error with no sentence of its own gets the one for the failed action.
	const generic =
		whatFailed === 'start'
			? 'Restart your computer, then open Namzu again. If it keeps happening, send the support logs.'
			: 'Namzu couldn’t close cleanly. Nothing you wrote is lost. Open it again.'
	// plainError's own fallback reads "Couldn’t …" or "That didn’t work"; the box says more.
	const sentence = /^(?:Couldn’t|That didn’t work)/.test(known.text) ? generic : known.text
	const details = (known.details ?? raw).trim().slice(0, 500)
	return details && details !== sentence ? `${sentence}\n\nDetails: ${details}` : sentence
}
