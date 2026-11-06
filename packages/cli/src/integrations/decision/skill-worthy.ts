/**
 * The third decision point: is this finished turn a procedure worth saving as a skill?
 *
 * The host's rule looks at the turn's shape (steps, distinct tools, a clean tail). It
 * cannot tell a routine the person will want again from a one-off that happened to take
 * six calls. The decision model reads what the turn was asked and which tools it used and
 * says whether it is a repeatable procedure. It only ever vetoes a proposal the rule
 * already makes; a proposal the rule did not make is never created by it.
 *
 * What is sent: the person's request (cut), the names of the tools used. No tool
 * arguments, no results, no file contents. Off unless named in `decision.points`.
 */

import type { DecisionPoints, DecisionQuestion } from './points.js'
import { verdictOf } from './points.js'

export const SKILL_WORTHY_REQUEST_CHARS = 600

export const SKILL_WORTHY_INSTRUCTIONS =
	'Is this a repeatable procedure that the person would want done the same way again on another day? ' +
	'Answer yes for a multi-step routine with a stable shape, such as preparing a release, setting up a project, or a recurring check. ' +
	'Answer no for a one-off task, an investigation into a particular problem, or work that only made sense for this one situation.'

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

export function skillWorthyQuestion(input: {
	readonly request: string
	readonly tools: readonly string[]
	readonly steps: number
}): DecisionQuestion {
	const request = [...printable(input.request).trim()].slice(0, SKILL_WORTHY_REQUEST_CHARS).join('')
	const tools = [...new Set(input.tools)].sort().join(', ')
	return {
		point: 'skill-worthy',
		state: `Request: ${request}\n\nThe turn took ${input.steps} steps using these tools: ${tools}`,
		instructions: SKILL_WORTHY_INSTRUCTIONS,
		// The rule has already said yes by the time this is asked.
		rule: true,
	}
}

/** Whether a proposal the rule made should still be shown: a confident no withdraws it. */
export async function skillProposalStands(
	points: DecisionPoints,
	input: { readonly request: string; readonly tools: readonly string[]; readonly steps: number },
	signal?: AbortSignal,
): Promise<boolean> {
	if (points.mode('skill-worthy') === 'off') return true
	const p = await points.ask(skillWorthyQuestion(input), signal)
	return verdictOf(p) !== 'no'
}
