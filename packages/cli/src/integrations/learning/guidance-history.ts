import { randomUUID } from 'node:crypto'
import type { DiskResidentAgenda, SqliteLearningStore } from '@namzu/sdk'
import { SESSION_SKILL } from './session-feed.js'

/**
 * What the built-in generator activated into a project's guidance, and the one
 * way back: restoring the revision that was active before a given activation,
 * by exact revision. Nothing here deletes history; an undo is itself a new
 * revision, so it can be inspected and is never silent.
 */
export interface LearnedRevision {
	readonly cycleId: string
	readonly at: number
	readonly revision: string
	readonly description: string
	readonly body: string
	/** The guidance this activation replaced, or `none`. */
	readonly replaced: string
	/** True for the revision conversations start with now. */
	readonly active: boolean
	/** The agenda revision this activation created, which an undo restores from. */
	readonly agendaRevision: number
}

/** Activations of this project's guidance, newest first. */
export async function listLearnedGuidance(
	store: SqliteLearningStore,
	agenda: Pick<DiskResidentAgenda, 'read'>,
): Promise<{ readonly active: string | null; readonly revisions: readonly LearnedRevision[] }> {
	const state = await agenda.read()
	const current = state?.learning?.skills.find((s) => s.name === SESSION_SKILL)?.hash ?? null
	const rows = await store.list({ limit: 100 })
	const revisions: LearnedRevision[] = []
	for (const row of rows) {
		const result = row.result
		if (
			row.skillName !== SESSION_SKILL ||
			result?.status !== 'activated' ||
			!result.candidate ||
			!result.candidateRevision ||
			result.agendaRevision === undefined
		)
			continue
		revisions.push({
			cycleId: row.cycleId,
			at: row.updatedAt,
			revision: result.candidateRevision,
			description: result.candidate.description,
			body: result.candidate.body,
			replaced: result.baselineRevision ?? 'none',
			active: result.candidateRevision === current,
			agendaRevision: result.agendaRevision,
		})
	}
	return { active: current, revisions }
}

export type UndoOutcome =
	| { readonly status: 'undone'; readonly revision: LearnedRevision; readonly restored: string }
	| {
			readonly status: 'refused'
			readonly reason: 'nothing-active' | 'unknown-cycle' | 'not-active' | 'history-missing'
	  }

/**
 * Undo an activation. Without a cycle id, the newest activation that is still
 * active. A revision that a later one replaced, or that is no longer active,
 * is refused rather than guessed at: undoing it by restoring an old snapshot
 * would also drop whatever came after.
 */
export async function undoLearnedGuidance(
	store: SqliteLearningStore,
	agenda: Pick<DiskResidentAgenda, 'read' | 'readRevision' | 'rollbackSkill'>,
	cycleId?: string,
): Promise<UndoOutcome> {
	const { revisions } = await listLearnedGuidance(store, agenda)
	const target = cycleId
		? revisions.find((r) => r.cycleId === cycleId)
		: revisions.find((r) => r.active)
	if (cycleId && !target) return { status: 'refused', reason: 'unknown-cycle' }
	if (!target) return { status: 'refused', reason: 'nothing-active' }
	if (!target.active) return { status: 'refused', reason: 'not-active' }
	const snapshot = await agenda.read()
	const before = target.agendaRevision - 1
	const historical = before >= 1 ? await agenda.readRevision(before) : null
	if (!snapshot || !historical) return { status: 'refused', reason: 'history-missing' }
	const previous = historical.learning?.skills.find((s) => s.name === SESSION_SKILL)?.hash ?? 'none'
	// The snapshot must be the one this activation replaced, or the history is not what it says.
	if (previous !== target.replaced) return { status: 'refused', reason: 'history-missing' }
	await agenda.rollbackSkill(snapshot, SESSION_SKILL, before, {
		key: randomUUID(),
		source: 'namzu-learn:undo',
		reason: 'The person reverted what Namzu learned for this project.',
	})
	return { status: 'undone', revision: target, restored: previous }
}

/** Plain words for a refused undo. */
export function describeUndoRefusal(
	reason: Extract<UndoOutcome, { status: 'refused' }>['reason'],
): string {
	switch (reason) {
		case 'nothing-active':
			return 'Nothing Namzu learned is active for this project.'
		case 'unknown-cycle':
			return 'No learned revision with that id is kept for this project.'
		case 'not-active':
			return 'That revision is no longer the active one. A later revision replaced it; undo that one first.'
		case 'history-missing':
			return 'The saved history for that revision is incomplete, so it was not changed.'
	}
}
