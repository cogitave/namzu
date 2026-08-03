import type { AdvisoryResult } from '../types/advisory/result.js'

/**
 * The response shape asked of every advisor.
 *
 * Appended to whatever prompt the advisor already carries — a persona or a
 * host-written system prompt describes WHO the advisor is, and this
 * describes how its answer is read back. Keeping it separate is what lets a
 * custom prompt keep working: the two used to be the same string, so an
 * advisor with its own prompt was never told the convention and its
 * warnings could not be found.
 */
export const ADVISORY_RESPONSE_CONTRACT = [
	'Write your advice as prose.',
	'If you have warnings the executing agent must not miss, put them in a `<warnings>` block, one per line, each starting with `-`.',
	'If you have made decisions the executing agent should carry forward, put them in a `<decisions>` block in the same form.',
	'Both blocks are optional. Omit a block entirely rather than emitting an empty one.',
].join(' ')

const BLOCK = (tag: string) => new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'gi')

/** Bullet, dash, asterisk or `1.` — whichever the model reached for. */
const LEADER = /^\s*(?:[-*•]|\d+[.)])\s*/

function itemsIn(block: string): string[] {
	return block
		.split('\n')
		.map((line) => line.replace(LEADER, '').trim())
		.filter((line) => line.length > 0)
}

/**
 * Read an advisor's answer.
 *
 * The structured half of `AdvisoryResult` had readers and no writer: the
 * parser returned `{ advice }` and nothing else, so an advisor's decisions
 * never reached working state and its warnings never reached the executing
 * agent. Both consumers were written, tested against hand-built results,
 * and permanently unreachable in a real run.
 */
export function parseAdvisoryResponse(rawContent: string): AdvisoryResult {
	const warnings: string[] = []
	const decisions: string[] = []
	let advice = rawContent

	for (const [tag, sink] of [
		['warnings', warnings],
		['decisions', decisions],
	] as const) {
		for (const match of rawContent.matchAll(BLOCK(tag))) {
			sink.push(...itemsIn(match[1] ?? ''))
		}
		// Stripped from the advice so the executing agent is not shown the
		// same warning twice — once as prose, once under its own heading.
		advice = advice.replace(BLOCK(tag), '')
	}

	return {
		advice: advice.trim(),
		...(warnings.length > 0 ? { warnings } : {}),
		...(decisions.length > 0 ? { decisions } : {}),
	}
}
