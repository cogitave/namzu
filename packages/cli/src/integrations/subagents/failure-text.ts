/**
 * The sentence a person reads when an agent fails.
 *
 * A failed provider call reaches the agent's row as the kernel's own wording,
 * `openai (HTTP 400) — the provider rejected the request as invalid: {...}`:
 * a wire name, a status line and the provider's raw body. None of that is for
 * a person. This maps the kernel's known causes to one plain sentence with a
 * next step; the raw text follows on the next line only when detail was
 * asked for (`--debug`), the same rule every other failure in the app uses.
 */

import { debugRequested } from '../../debug-requested.js'

/** The kernel's cause phrases (sdk `KIND_SENTENCE`), each with the plain sentence that replaces it. */
const CAUSES: readonly (readonly [RegExp, string])[] = [
	[
		/rate limited by the provider/i,
		'The provider was too busy for this agent. Wait a moment, then message the agent to try again.',
	],
	[
		/could not reach the provider/i,
		'Namzu could not reach the provider. Check the connection, then message the agent to try again.',
	],
	[
		/the provider rejected the request credentials/i,
		'The provider did not accept the sign-in. Sign in again, then start the task again.',
	],
	[
		/exceeded the model context window/i,
		'The task was too large for the model. Start it again with a smaller task.',
	],
	[
		/the provider rejected the request as invalid/i,
		'The provider could not use this request. Start the task again, or choose another model.',
	],
	[
		/the provider failed to complete the request/i,
		'The provider ran into a problem. Wait a moment, then message the agent to try again.',
	],
]

const GENERIC = 'This agent stopped because of an error. Run with --debug for details.'

/** A message that is already a finished sentence for a person: short, capitalised, one line, no code. */
function isPlainSentence(text: string): boolean {
	if (text.length < 8 || text.length > 220) return false
	if (!/^[A-Z]/u.test(text) || !/[.!?]$/u.test(text)) return false
	return !/[\n\r{}[\]\\]|\w\/\w|~\/|\bat \S+:\d+|\b(?:undefined|null|NaN)\b|\bHTTP \d{3}\b/u.test(
		text,
	)
}

/** One plain sentence (and a next step) for a failure's raw text; the raw text follows only under `--debug`. */
export function plainAgentFailure(raw: string, debug: boolean = debugRequested()): string {
	const text = raw.trim()
	const plain =
		CAUSES.find(([pattern]) => pattern.test(text))?.[1] ?? (isPlainSentence(text) ? text : GENERIC)
	return debug && text !== '' && text !== plain ? `${plain}\n${text}` : plain
}
