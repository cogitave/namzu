/**
 * Consolidation: what a turn learned, written down where a later turn can
 * find it.
 *
 * The working state is episodic memory — what happened in THIS turn: the
 * decisions taken, the discoveries made, the failures met and how. It
 * dies with the turn, and the semantic store behind `search_memory` only
 * ever received what a model chose to `save_memory` mid-task, which is
 * rarely the thing a later turn needed. Consolidation is the bridge: at
 * the end of a turn, the entries that can outlive it become one memory
 * entry, tagged so a later turn can search for what was learned rather
 * than what was done. What is deliberately NOT carried: the tool
 * results, the plan, the requirements — those describe the task, not a
 * lesson. Pure: the caller writes the entry, this only says what it is.
 */

import {
	KNOWLEDGE_TAG_PREFIX,
	holdsKnowledgeDigest,
	knowledgeDigest,
} from '../store/memory/digest.js'
import { CONSOLIDATION_KIND } from '../store/memory/origin.js'
import type { SessionId, TurnId } from '../types/ids/index.js'
import type { CreateMemoryParams, MemoryStore } from '../types/memory/index.js'
import type { WorkingState } from './types.js'

export const CONSOLIDATION_TAG = 'learning'

export interface ConsolidationMeta {
	/** The session the learning turn belongs to; tagged `session:<id>`. */
	readonly sessionId: SessionId
	/** The turn that learned it; tagged `turn:<id>`. */
	readonly turnId: TurnId
	/** Milliseconds since the epoch, for the entry's metadata. */
	readonly at: number
}

const MAX_TASK_IN_TITLE = 72

function head(text: string, max: number): string {
	const line = text.split('\n')[0]?.trim() ?? ''
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`
}

/**
 * Whether `store` already holds a consolidation of exactly this knowledge.
 *
 * {@link consolidationEntry} is pure and cannot ask; the caller asks this
 * before writing, the way the promoter does, so a turn that learned what an
 * earlier turn already recorded — archived included — writes nothing.
 */
export async function isConsolidated(
	store: MemoryStore,
	entry: CreateMemoryParams,
): Promise<boolean> {
	const digest = entry.metadata?.knowledgeDigest
	if (typeof digest !== 'string') return false
	return holdsKnowledgeDigest(
		store,
		[CONSOLIDATION_TAG],
		digest,
		(metadata) => metadata?.kind === CONSOLIDATION_KIND,
	)
}

/**
 * The memory entry a turn's state consolidates to, or `null` when the turn
 * learned nothing worth a later turn's attention — no decisions, no
 * discoveries, no failures. A turn that only read and edited leaves no
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
	// What was learned, not which turn learned it: two turns reaching the same
	// decisions, discoveries and failures consolidate to one record.
	const digest = knowledgeDigest({ decisions, discoveries, failures })
	return {
		title: task ? `Learned: ${head(task, MAX_TASK_IN_TITLE)}` : `Learned in turn ${meta.turnId}`,
		summary: `${counts.join(', ')} from turn ${meta.turnId} of session ${meta.sessionId}.`,
		content,
		format: 'markdown',
		type: 'project',
		tags: [
			CONSOLIDATION_TAG,
			`session:${meta.sessionId}`,
			`turn:${meta.turnId}`,
			`${KNOWLEDGE_TAG_PREFIX}${digest}`,
		],
		metadata: {
			sessionId: meta.sessionId,
			turnId: meta.turnId,
			consolidatedAt: meta.at,
			kind: CONSOLIDATION_KIND,
			knowledgeDigest: digest,
		},
	}
}
