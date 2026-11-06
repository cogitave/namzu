/**
 * The second decision point: is what this turn learned worth remembering?
 *
 * At settle the session's promoter writes one stored memory for any turn whose
 * compaction pass extracted a claim. That rule keeps what a turn happened to learn, and
 * a store of such records fills with routine progress and facts the code already
 * states, which the model then reads on every search. The decision model reads the
 * claims and says whether a later session in the same project would be helped by
 * them. A confident no writes nothing; anything else, and any failure, writes as before.
 *
 * What is asked is the task and the claims themselves (requirements, decisions,
 * discoveries, failures, environment), so the point is off unless the operator named it
 * in `decision.points`. File paths are not sent.
 */

import type { PromoteMemory } from '@namzu/sdk'
import { type DecisionPoints, type DecisionQuestion, verdictOf } from './points.js'

type Candidate = Parameters<PromoteMemory>[0]

export const MEMORY_ADMIT_INSTRUCTIONS =
	'Would a later working session in the same project be helped by remembering this? ' +
	'Answer yes for requirements the person stated, decisions with their reasons, non-obvious discoveries about how the project works, and mistakes worth not repeating. ' +
	'Answer no for routine progress, facts that are easy to read again from the code, and details of this one turn that will not matter later.'

/** How much of the claims the model reads. */
export const MEMORY_ADMIT_STATE_CHARS = 1_600

const SECTIONS = [
	['userRequirements', 'The person requires'],
	['decisions', 'Decisions'],
	['discoveries', 'Discoveries'],
	['failures', 'What did not work'],
	['environment', 'Environment'],
] as const

function claims(candidate: Candidate): readonly (readonly [string, readonly string[]])[] {
	const out: (readonly [string, readonly string[]])[] = []
	for (const [key, heading] of SECTIONS) {
		const items = candidate[key].map((item) => item.trim()).filter(Boolean)
		if (items.length > 0) out.push([heading, items])
	}
	return out
}

/** Whether the candidate holds a claim at all: with none, the promoter writes nothing and nothing is asked. */
export function holdsClaims(candidate: Candidate): boolean {
	return claims(candidate).length > 0
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

export function memoryAdmitQuestion(candidate: Candidate): DecisionQuestion {
	const text = [
		`Task: ${candidate.task.trim()}`,
		...claims(candidate).map(
			([heading, items]) => `${heading}:\n${items.map((i) => `- ${i}`).join('\n')}`,
		),
	].join('\n\n')
	return {
		point: 'memory',
		state: [...printable(text)].slice(0, MEMORY_ADMIT_STATE_CHARS).join(''),
		instructions: MEMORY_ADMIT_INSTRUCTIONS,
		// The rule writes whenever there is a claim.
		rule: true,
	}
}

/** The promoter, behind the point: a confident no from the model writes nothing, otherwise the promoter runs. */
export function gateMemoryPromotion(promote: PromoteMemory, points: DecisionPoints): PromoteMemory {
	return async (candidate) => {
		if (points.mode('memory') === 'off' || !holdsClaims(candidate)) return promote(candidate)
		const p = await points.ask(memoryAdmitQuestion(candidate))
		if (verdictOf(p) === 'no') return
		return promote(candidate)
	}
}
