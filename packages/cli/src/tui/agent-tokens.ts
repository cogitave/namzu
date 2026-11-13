/**
 * The token numbers beside an agent or a workflow, and the one thing each means.
 *
 * A record keeps the child's CUMULATIVE usage (`tokens`): every request of its
 * turn sends the whole conversation again, so that figure grows with the square
 * of the steps and says little about what the agent did. What a person reads
 * beside an agent is what it WROTE (`outputTokens`), the same quantity the main
 * turn's row shows. What it was sent, and how much of that the cache answered,
 * is shown in words where there is room for them.
 */

import type { SubagentActivity } from '../integrations/subagents/activity.js'
import { formatCompactCount } from './units.js'

type Wrote = Pick<SubagentActivity, 'outputTokens'>

/** What the agent wrote, when it has reported some. Zero is the same as nothing yet. */
export function wroteOf(agent: Wrote): number | undefined {
	return agent.outputTokens !== undefined && agent.outputTokens > 0 ? agent.outputTokens : undefined
}

/** What several agents wrote together; `undefined` when none has reported any. */
export function wroteBy(agents: readonly Wrote[]): number | undefined {
	let sum: number | undefined
	for (const agent of agents) {
		const wrote = wroteOf(agent)
		if (wrote !== undefined) sum = (sum ?? 0) + wrote
	}
	return sum
}

/** `↓ 6.2k tokens`: the rail's form, with the main row's arrow and meaning. */
export function wroteRailText(wrote: number | undefined): string | undefined {
	return wrote === undefined ? undefined : `↓ ${formatCompactCount(wrote)} tokens`
}

/** `6.2k tokens written`: the form a line of the transcript uses. */
export function wroteLineText(wrote: number | undefined): string | undefined {
	return wrote === undefined ? undefined : `${formatCompactCount(wrote)} tokens written`
}

/** The same as a list of zero or one parts, ready to spread into a line. */
export function wroteLineParts(wrote: number | undefined): string[] {
	const text = wroteLineText(wrote)
	return text === undefined ? [] : [text]
}

/**
 * `wrote 6.2k · sent 1.17M (980k cached)`: the full picture of one agent, from
 * the fields its usage carries. `sent` is the prompts of all its requests added
 * up as the driver reported them; the cached part is named only when the driver
 * reported some and it fits inside what was sent.
 */
export function agentUsageText(
	agent: Pick<SubagentActivity, 'outputTokens' | 'sentTokens' | 'cachedTokens'>,
): string | undefined {
	const wrote = wroteOf(agent)
	const sent = agent.sentTokens !== undefined && agent.sentTokens > 0 ? agent.sentTokens : undefined
	const cached =
		sent !== undefined &&
		agent.cachedTokens !== undefined &&
		agent.cachedTokens > 0 &&
		agent.cachedTokens <= sent
			? agent.cachedTokens
			: undefined
	const parts = [
		...(wrote !== undefined ? [`wrote ${formatCompactCount(wrote)}`] : []),
		...(sent !== undefined
			? [
					`sent ${formatCompactCount(sent)}${
						cached !== undefined ? ` (${formatCompactCount(cached)} cached)` : ''
					}`,
				]
			: []),
	]
	return parts.length > 0 ? parts.join(' · ') : undefined
}
