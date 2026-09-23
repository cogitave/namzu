/**
 * The rows delegated work leaves in the conversation, as plain data.
 *
 * Three kinds, each written once into settled history and never updated in
 * place (settled rows cannot be repainted; the live state belongs to the
 * rail under the footer):
 *
 * - a launch receipt per batch of agents: `● Launched 2 agents · <workflow> / <phase>`
 *   with the agents' names beneath it as a `├`/`└` tree;
 * - a completion row per agent: `✓ <name> · 1.7s · 9.0k tokens`, carrying the
 *   agent's final answer as a collapsed body Ctrl+O opens;
 * - a closing line when a turn that delegated settles:
 *   `✻ Worked for 38s · 3 agents in 2 phases · 27.0k tokens`.
 *
 * Pure so the wording is tested without an App.
 */

import {
	DEFAULT_AGENT_PHASE,
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
} from '../integrations/subagents/activity.js'
import { formatCompactCount } from './AgentExplorer.js'
import { formatElapsed } from './LiveActivity.js'
import { terminalDisplayText } from './terminal-display.js'

/** The key that opens the agent browser from anywhere the composer is. Never a key that may be dead. */
export const AGENT_MANAGE_HINT = 'ctrl+t to manage'

export interface LaunchReceipt {
	/** First line, then one tree line per agent when there are several. */
	readonly content: string
}

/**
 * One receipt for the agents a single model response launched together.
 *
 * `unordered` share a batch; the receipt lists them by start time.
 * The workflow and phase labels are named only when the model supplied them
 * — the unlabelled defaults name nothing about THESE agents, the same rule
 * the rail's title follows.
 */
export function launchReceipt(unordered: readonly SubagentActivity[]): LaunchReceipt {
	// The monitor lists live agents before settled ones; a receipt names them
	// in the order they started.
	const members = [...unordered].sort((left, right) => left.startedAt - right.startedAt)
	const first = members[0]
	const labels = first
		? [
				...(first.workflow !== DEFAULT_AGENT_WORKFLOW ? [first.workflow] : []),
				...(first.phase !== DEFAULT_AGENT_PHASE ? [first.phase] : []),
			].map((label) => oneLine(label))
		: []
	const where = labels.length > 0 ? ` · ${labels.join(' / ')}` : ''
	if (members.length === 1 && first) {
		return {
			content: `Launched ${oneLine(first.description || first.agentId)}${where} (${AGENT_MANAGE_HINT})`,
		}
	}
	const tree = members.map(
		(agent, index) =>
			`${index === members.length - 1 ? '└' : '├'} ${oneLine(agent.description || agent.agentId)}`,
	)
	return {
		content: [`Launched ${members.length} agents${where} (${AGENT_MANAGE_HINT})`, ...tree].join(
			'\n',
		),
	}
}

export interface CompletionRow {
	readonly ok: boolean
	readonly content: string
	/** The agent's final answer, one entry per line; empty when it gave none. */
	readonly detail: readonly string[]
	readonly hint: string
}

/** The row for one agent that reached a terminal state. */
export function completionRow(agent: SubagentActivity, now = Date.now()): CompletionRow {
	const name = oneLine(agent.description || agent.agentId)
	const elapsed = formatElapsed(Math.max(0, (agent.completedAt ?? now) - agent.startedAt))
	const detail = finalAnswer(agent)
	const hint = detail.length > 0 ? 'ctrl+o result · ctrl+t details' : 'ctrl+t details'
	if (agent.status === 'completed') {
		const tokens = agent.tokens !== undefined ? ` · ${formatCompactCount(agent.tokens)} tokens` : ''
		return { ok: true, content: `${name} · ${elapsed}${tokens}`, detail, hint }
	}
	if (agent.status === 'cancelled') {
		return { ok: false, content: `${name} · cancelled after ${elapsed}`, detail, hint }
	}
	const reason = agent.latestActivity ? oneLine(agent.latestActivity) : 'Failed'
	return { ok: false, content: `${name} · failed after ${elapsed} · ${reason}`, detail, hint }
}

/**
 * `Worked for 38s · 3 agents in 2 phases · 27.0k tokens`, or `undefined` for
 * a turn that delegated nothing.
 *
 * The phase count appears only when the model named two or more phases, the
 * tokens only when a child reported spend, and `· 1 failed` only when one
 * did: the reference closes a workflow with its agent count and spend, and a
 * failure is worth the words.
 */
export function settleLine(
	elapsedMs: number,
	agents: readonly SubagentActivity[],
): string | undefined {
	if (agents.length <= 0) return undefined
	const phases = new Set(
		agents.filter((agent) => agent.phase !== DEFAULT_AGENT_PHASE).map((agent) => agent.phaseId),
	).size
	const spent = agents.reduce<number | undefined>(
		(sum, agent) => (agent.tokens === undefined ? sum : (sum ?? 0) + agent.tokens),
		undefined,
	)
	const failed = agents.filter((agent) => agent.status === 'failed').length
	return [
		`Worked for ${formatElapsed(Math.max(0, elapsedMs))}`,
		`${agents.length} agent${agents.length === 1 ? '' : 's'}${phases >= 2 ? ` in ${phases} phases` : ''}`,
		...(spent !== undefined ? [`${formatCompactCount(spent)} tokens`] : []),
		...(failed > 0 ? [`${failed} failed`] : []),
	].join(' · ')
}

/**
 * The child's last reply, as lines. Child text is untrusted and goes through
 * the same display projection every other row does; the transcript's own
 * preview limits apply on top.
 */
function finalAnswer(agent: SubagentActivity): readonly string[] {
	for (let index = agent.transcript.length - 1; index >= 0; index -= 1) {
		const row = agent.transcript[index]
		if (row?.kind === 'assistant' && row.text.trim().length > 0) {
			return terminalDisplayText(row.text.trim()).split(/\r?\n/)
		}
	}
	return []
}

function oneLine(text: string): string {
	return terminalDisplayText(text).replace(/\r?\n/g, ' ').replace(/\t/g, ' ')
}
