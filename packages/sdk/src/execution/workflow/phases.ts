import { normalizePhaseTitle } from './meta.js'
import type {
	WorkflowAgentState,
	WorkflowPhaseMeta,
	WorkflowPhaseStatus,
	WorkflowPhaseSummary,
} from './types.js'

export interface PhaseRecord {
	readonly index: number
	readonly title: string
	readonly declared: boolean
}

/**
 * Phase titles of one run. A title is the only grouping key: the same title
 * is the same group. Indexes are 1-based first-seen order, declared titles
 * first. `register` reports whether the title was announced just now.
 */
export class PhaseRegistry {
	private readonly byTitle = new Map<string, PhaseRecord>()

	register(rawTitle: string, declared = false): { phase: PhaseRecord; isNew: boolean } {
		const title = normalizePhaseTitle(rawTitle)
		const existing = this.byTitle.get(title)
		if (existing) return { phase: existing, isNew: false }
		const phase = { index: this.byTitle.size + 1, title, declared }
		this.byTitle.set(title, phase)
		return { phase, isNew: true }
	}

	all(): PhaseRecord[] {
		return [...this.byTitle.values()]
	}
}

export interface PhaseAgentView {
	readonly phaseIndex?: number
	readonly state: WorkflowAgentState
	readonly tokens: number
}

function statusOf(total: number, done: number, failed: number): WorkflowPhaseStatus {
	if (total === 0) return 'not-started'
	if (done + failed === total) return failed > 0 ? 'failed' : 'done'
	return 'running'
}

/**
 * Per-phase status from the agents seen so far, in phase order. A phase with
 * no agent yet is `not-started`. When no agent belongs to any phase (and
 * nothing is declared) the run shows one derived group, "Agents"; agents
 * without a phase next to phased ones also land in "Agents", listed last.
 */
export function summarizeWorkflowPhases(
	declared: readonly WorkflowPhaseMeta[],
	phases: readonly PhaseRecord[],
	agents: readonly PhaseAgentView[],
): WorkflowPhaseSummary[] {
	const detail = new Map(declared.map((p) => [normalizePhaseTitle(p.title), p.detail]))
	const summarize = (
		index: number,
		title: string,
		members: readonly PhaseAgentView[],
		extra?: string,
	): WorkflowPhaseSummary => {
		const done = members.filter((a) => a.state === 'done').length
		const failed = members.filter((a) => a.state === 'error').length
		return {
			index,
			title,
			...(extra !== undefined ? { detail: extra } : {}),
			status: statusOf(members.length, done, failed),
			agents: members.length,
			done,
			failed,
			tokens: members.reduce((sum, a) => sum + a.tokens, 0),
		}
	}
	const out = phases.map((p) =>
		summarize(
			p.index,
			p.title,
			agents.filter((a) => a.phaseIndex === p.index),
			detail.get(p.title),
		),
	)
	const ungrouped = agents.filter((a) => a.phaseIndex === undefined)
	if (ungrouped.length > 0) out.push(summarize(0, 'Agents', ungrouped))
	return out
}
