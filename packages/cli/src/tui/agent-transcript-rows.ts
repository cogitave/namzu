/**
 * The rows delegated work leaves in the conversation, as plain data.
 *
 * Three kinds, each written once into settled history and never updated in
 * place (settled rows cannot be repainted; the live state belongs to the
 * rail under the footer):
 *
 * - a launch receipt per batch of unlabelled agents: `● Launched 2 agents`
 *   with the agents' names beneath it as a `├`/`└` tree; agents the model
 *   gave a `workflow` label get ONE group line instead,
 *   `● Workflow <name>` / `⎿ Running in background · ↓ to manage`;
 * - a completion row per unlabelled agent: `✓ <name> · 1.7s · 9.0k tokens`,
 *   carrying the agent's final answer as a collapsed body Ctrl+O opens (a
 *   workflow's agents are read in its detail view, and the workflow closes
 *   with one line);
 * - a closing line when a turn that delegated settles:
 *   `✻ Worked for 38s · 3 agents · 27.0k tokens`.
 *
 * Pure so the wording is tested without an App.
 */

import {
	DEFAULT_AGENT_PHASE,
	DEFAULT_AGENT_WORKFLOW,
	type SubagentActivity,
} from '../integrations/subagents/activity.js'
import { type RailWorkflow, formatCompactCount } from './AgentExplorer.js'
import { formatElapsed } from './LiveActivity.js'
import { terminalDisplayText } from './terminal-display.js'

/**
 * The key that reaches the agents from an empty composer: `↓` focuses the
 * footer (the shells pill, then the rail rows). The same words the shell cell
 * and the workflow launch use, so one key is named for all background work.
 */
export const AGENT_MANAGE_HINT = '↓ to manage'

/** The key that opens the rail's workflow row from the composer. */
export const WORKFLOW_MANAGE_HINT = '↓ to manage'

/**
 * How a launch names an agent: `name: description`, or just the name when the
 * description is the same words, or the description alone for an agent with no
 * name (a saved one).
 */
export function launchLabel(agent: SubagentActivity): string {
	const description = oneLine(agent.description)
	if (agent.name === undefined) return description || oneLine(agent.agentId)
	return description && description !== agent.name
		? `${oneLine(agent.name)}: ${description}`
		: oneLine(agent.name)
}

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
	// Agents the model gave a `workflow` label are one piece of work, however
	// many of them there are: one group line, no per-agent rows.
	if (first && first.workflow !== DEFAULT_AGENT_WORKFLOW) {
		return {
			content: `Workflow ${oneLine(first.workflow)}\n⎿ Running in background · ${WORKFLOW_MANAGE_HINT}`,
		}
	}
	const labels = first
		? [
				...(first.workflow !== DEFAULT_AGENT_WORKFLOW ? [first.workflow] : []),
				...(first.phase !== DEFAULT_AGENT_PHASE ? [first.phase] : []),
			].map((label) => oneLine(label))
		: []
	const where = labels.length > 0 ? ` · ${labels.join(' / ')}` : ''
	if (members.length === 1 && first) {
		return {
			content: `Launched ${launchLabel(first)}${where} (${AGENT_MANAGE_HINT})`,
		}
	}
	const tree = members.map(
		(agent, index) => `${index === members.length - 1 ? '└' : '├'} ${launchLabel(agent)}`,
	)
	// Agents started in the background say so; a batch the turn waits on does not.
	const headline = members.every((agent) => agent.background === true)
		? `${members.length} background agents launched${where} (${AGENT_MANAGE_HINT})`
		: `Launched ${members.length} agents${where} (${AGENT_MANAGE_HINT})`
	return { content: [headline, ...tree].join('\n') }
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
	const name = oneLine(agent.name ?? (agent.description || agent.agentId))
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

export interface WorkflowNotice {
	readonly content: string
	/** Completed reads quiet, failed is red, stopped is yellow. */
	readonly tone: 'ok' | 'error' | 'warn'
	readonly glyph: string
}

/**
 * The one line a workflow leaves in the conversation when its last agent
 * settles: `Workflow Release audit completed · 4m02s · 7 agents · 112k tokens`.
 * Written once per settled workflow, below the last agent's own row.
 */
export function workflowNotice(workflow: RailWorkflow, now = Date.now()): WorkflowNotice {
	const word =
		workflow.status === 'failed'
			? 'failed'
			: workflow.status === 'stopped'
				? 'stopped'
				: 'completed'
	const elapsed = formatElapsed(Math.max(0, (workflow.endedAt ?? now) - workflow.startedAt))
	const parts = [
		`Workflow ${oneLine(workflow.name)} ${word}`,
		elapsed,
		`${workflow.total} agent${workflow.total === 1 ? '' : 's'}`,
		...(workflow.failed > 0 ? [`${workflow.failed} failed`] : []),
		...(workflow.tokens !== undefined ? [`${formatCompactCount(workflow.tokens)} tokens`] : []),
	]
	return {
		content: parts.join(' · '),
		tone: workflow.status === 'failed' ? 'error' : workflow.status === 'stopped' ? 'warn' : 'ok',
		glyph: workflow.status === 'failed' ? '✗' : workflow.status === 'stopped' ? '■' : '✓',
	}
}

/**
 * A turn that delegated nothing and took less than this closes without a
 * line: an answer that arrived at once needs no account of how long it took.
 */
export const SETTLE_LINE_MIN_MS = 3_000

/**
 * `Worked for 38s · 3 agents · 27.0k tokens`, or `Worked for 46s`
 * for a turn that delegated nothing — a finished turn closes with how long it
 * took, as the reference terminal's do — or `undefined` for a turn that
 * delegated nothing and finished within {@link SETTLE_LINE_MIN_MS}.
 *
 * Phases never appear here: the reference shows them only inside a
 * workflow's detail view. The tokens appear only when a child reported
 * spend, and `· 1 failed` only when one did.
 */
export function settleLine(
	elapsedMs: number,
	agents: readonly SubagentActivity[],
): string | undefined {
	if (agents.length <= 0)
		return elapsedMs >= SETTLE_LINE_MIN_MS ? `Worked for ${formatElapsed(elapsedMs)}` : undefined
	const spent = agents.reduce<number | undefined>(
		(sum, agent) => (agent.tokens === undefined ? sum : (sum ?? 0) + agent.tokens),
		undefined,
	)
	const failed = agents.filter((agent) => agent.status === 'failed').length
	return [
		`Worked for ${formatElapsed(Math.max(0, elapsedMs))}`,
		`${agents.length} agent${agents.length === 1 ? '' : 's'}`,
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
