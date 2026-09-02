/**
 * Consolidation: what a run learned, written down where the next run can
 * find it.
 *
 * The working state is episodic memory — what happened in THIS run: the
 * decisions taken, the discoveries made, the failures met and how. It
 * dies with the run, and the semantic store behind `search_memory` only
 * ever received what a model chose to `save_memory` mid-task, which is
 * rarely the thing a later run needed. Consolidation is the bridge: at
 * the end of a run, the entries that can outlive it become one memory
 * entry, tagged so a later run can search for what was learned rather
 * than what was done. What is deliberately NOT carried: the tool
 * results, the plan, the requirements — those describe the task, not a
 * lesson. Pure: the caller writes the entry, this only says what it is.
 */

import type { CreateMemoryParams } from '../types/memory/index.js'
import type { WorkingState } from './types.js'

export const CONSOLIDATION_TAG = 'learning'

export interface ConsolidationMeta {
	readonly runId: string
	/** Milliseconds since the epoch, for the entry's metadata. */
	readonly at: number
}

const MAX_TASK_IN_TITLE = 72

function head(text: string, max: number): string {
	const line = text.split('\n')[0]?.trim() ?? ''
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * The memory entry a run's state consolidates to, or `null` when the run
 * learned nothing worth a later run's attention — no decisions, no
 * discoveries, no failures. A run that only read and edited leaves no
 * entry rather than an empty one.
 */
export function consolidationEntry(
	state: WorkingState,
	meta: ConsolidationMeta,
): CreateMemoryParams | null {
	const decisions = state.decisions.filter((d) => d.trim().length > 0)
	const discoveries = state.discoveries.filter((d) => d.trim().length > 0)
	const failures = state.failures.filter((f) => f.trim().length > 0)
	if (decisions.length + discoveries.length + failures.length === 0) return null

	const task = state.task.trim()
	const files = [...state.files.values()]
		.filter((slot) => slot.actions.some((a) => a.type !== 'read'))
		.map((slot) => slot.path)
	const section = (name: string, items: readonly string[]): string[] =>
		items.length === 0 ? [] : [`## ${name}`, '', ...items.map((item) => `- ${item}`), '']
	const content = [
		task ? `Task: ${task}` : 'Task: (not stated)',
		'',
		...section('Decisions', decisions),
		...section('Discoveries', discoveries),
		...section('Failures and what was done about them', failures),
		...(files.length ? ['## Files changed', '', ...files.map((f) => `- \`${f}\``), ''] : []),
	].join('\n')
	const counts = [
		decisions.length ? `${decisions.length} decision${decisions.length === 1 ? '' : 's'}` : '',
		discoveries.length
			? `${discoveries.length} discover${discoveries.length === 1 ? 'y' : 'ies'}`
			: '',
		failures.length ? `${failures.length} failure${failures.length === 1 ? '' : 's'}` : '',
	].filter((part) => part.length > 0)
	return {
		title: task ? `Learned: ${head(task, MAX_TASK_IN_TITLE)}` : `Learned in run ${meta.runId}`,
		summary: `${counts.join(', ')} from run ${meta.runId}.`,
		content,
		format: 'markdown',
		tags: [CONSOLIDATION_TAG, `run:${meta.runId}`],
		metadata: { runId: meta.runId, consolidatedAt: meta.at, kind: 'consolidation' },
	}
}
