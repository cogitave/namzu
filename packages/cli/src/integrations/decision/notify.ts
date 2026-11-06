/**
 * The first decision point: is this finished reply worth calling the person back for?
 *
 * The host's rule is the length of the turn: a turn that ran ten seconds or more
 * ends with a chime, a shorter one is silent because the person was watching it. A
 * length says nothing about what the reply is, so a four-second answer that stops to
 * ask which of two things to do is silent while a long turn that ends in "done" rings.
 * The decision model reads the end of the reply and says whether it needs the person.
 *
 * The question carries the last part of the reply, so it is only asked when the
 * operator turned the point on (`decision.points.notify`).
 */

import type { DecisionQuestion } from './points.js'

/** How much of the end of the reply the model reads. The end is where a question sits. */
export const NOTIFY_WORTHY_TAIL_CHARS = 1_200

export const NOTIFY_WORTHY_INSTRUCTIONS =
	'Would a person who stepped away from the terminal want to be called back right now? ' +
	'Answer yes when the reply asks them something, needs their decision or approval, hands over a finished result, or reports a failure they must act on. ' +
	'Answer no for progress notes, acknowledgements, and a short answer to something they just asked and are watching for.'

export interface NotifyWorthyInput {
	/** The reply the turn ended with, as written. */
	readonly reply: string
	readonly turnMs: number
	/** Whether the host's own rule (a turn of ten seconds or more) would sound. */
	readonly rule: boolean
}

/** Control characters other than newline and tab are dropped before the text leaves the machine. */
function printable(text: string): string {
	let out = ''
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0
		if ((code < 0x20 && code !== 0x0a && code !== 0x09) || code === 0x7f) continue
		out += ch
	}
	return out
}

export function notifyWorthyQuestion(input: NotifyWorthyInput): DecisionQuestion {
	const chars = [...printable(input.reply).trim()]
	const tail = chars.slice(-NOTIFY_WORTHY_TAIL_CHARS).join('')
	const seconds = Math.round(input.turnMs / 1000)
	return {
		point: 'notify',
		state: `${tail}\n\n[the turn took ${seconds}s]`,
		instructions: NOTIFY_WORTHY_INSTRUCTIONS,
		rule: input.rule,
	}
}
