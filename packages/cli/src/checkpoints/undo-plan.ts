/**
 * What undoing a turn would do to each file, decided without touching one.
 *
 * Pure: the manifests and the disk's current state go in, a plan comes out.
 * The preview and the apply both call it, so what the operator was shown is
 * what runs, and `planToken` is how the apply knows nothing moved in between.
 *
 * A file is only ever written when the disk still holds exactly what the
 * turn left there. Anything else is a conflict and is skipped by default.
 */

import { createHash } from 'node:crypto'

import type { BlobRef, EntryState, TurnStatus } from './manifest.js'

/** What is on disk at a path right now. */
export type DiskState =
	| { kind: 'absent' }
	| { kind: 'file'; sha256: string; mode: number }
	| { kind: 'symlink' }
	/** A directory, or anything else that is not a file. */
	| { kind: 'other' }
	/** The path now resolves outside the project. */
	| { kind: 'outside' }

export type PlanAction = 'restore' | 'delete' | 'noop' | 'conflict'

export type ConflictReason = 'drifted' | 'later-reply' | 'unavailable' | 'symlink' | 'outside-cwd'

export interface PlanEntry {
	path: string
	rel: string
	before: BlobRef | null
	after: BlobRef | null
	state: EntryState
	/** The body undo would write back is gone. */
	beforeMissing: boolean
}

export interface PlanTurn {
	turnId: string
	seq: number
	status: TurnStatus
	/** Retention removed the bodies. */
	pruned: boolean
	entries: readonly PlanEntry[]
}

export interface PlanInput {
	turnId: string
	/** Also undo later replies that changed the same files, newest first. */
	alsoUndoLater: boolean
	turns: readonly PlanTurn[]
	/** The current state of every path any involved entry names. */
	disk: ReadonlyMap<string, DiskState>
	/** Compare permission bits too. False on Windows, where they are not the file's own. */
	compareMode?: boolean
}

export interface PlanFile {
	/** The turn whose change this step takes back. */
	turnId: string
	path: string
	rel: string
	action: PlanAction
	reason?: ConflictReason
	/** The later replies standing in the way. */
	blockedBy?: string[]
	/** The disk state this step expects to find, as a token. */
	cur: string
}

export interface UndoPlan {
	turnId: string
	alsoUndoLater: boolean
	planToken: string
	/** In the order they must run: later replies first, the target last. */
	files: PlanFile[]
}

export class PlanError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PlanError'
	}
}

export function diskToken(state: DiskState, compareMode = true): string {
	switch (state.kind) {
		case 'file':
			return compareMode ? `file:${state.sha256}:${state.mode.toString(8)}` : `file:${state.sha256}`
		default:
			return state.kind
	}
}

function refToDisk(ref: BlobRef | null): DiskState {
	return ref === null ? { kind: 'absent' } : { kind: 'file', sha256: ref.sha256, mode: ref.mode }
}

function same(cur: DiskState, ref: BlobRef | null, compareMode: boolean): boolean {
	if (ref === null) return cur.kind === 'absent'
	return cur.kind === 'file' && cur.sha256 === ref.sha256 && (!compareMode || cur.mode === ref.mode)
}

/** Windows paths differ by case only; two spellings are one file. */
function samePath(a: string, b: string): boolean {
	return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function sameRef(a: BlobRef | null, b: BlobRef | null): boolean {
	if (a === null || b === null) return a === b
	return a.sha256 === b.sha256
}

interface Step {
	action: PlanAction
	reason?: ConflictReason
	/** The disk once the step has run. */
	next: DiskState
}

/** One entry against one disk state: the decision table. */
function decide(entry: PlanEntry, cur: DiskState, compareMode: boolean): Step {
	const keep = (reason: ConflictReason): Step => ({ action: 'conflict', reason, next: cur })
	if (entry.state === 'pending') return keep('unavailable')
	if (cur.kind === 'symlink') return keep('symlink')
	if (cur.kind === 'outside') return keep('outside-cwd')
	if (cur.kind === 'other') return keep('drifted')
	// Already where undo would leave it: also what makes a rerun after a crash a no-op.
	if (same(cur, entry.before, compareMode)) return { action: 'noop', next: cur }
	if (same(cur, entry.after, compareMode)) {
		if (entry.before === null) return { action: 'delete', next: { kind: 'absent' } }
		if (entry.beforeMissing) return keep('unavailable')
		return { action: 'restore', next: refToDisk(entry.before) }
	}
	// A created file that is not what the turn wrote is never deleted.
	return keep('drifted')
}

export function planUndo(input: PlanInput): UndoPlan {
	const compareMode = input.compareMode ?? true
	const target = input.turns.find((t) => t.turnId === input.turnId)
	if (!target) throw new PlanError(`No file history for turn ${input.turnId}.`)

	// Later replies that still stand, oldest first.
	const later = input.turns
		.filter((t) => t.seq > target.seq && t.status !== 'undone' && !t.pruned)
		.sort((a, b) => a.seq - b.seq)

	const files: PlanFile[] = []
	const involved = new Set<string>([target.turnId])
	const stateOf = (path: string): DiskState => input.disk.get(path) ?? { kind: 'absent' }

	for (const entry of target.entries) {
		if (entry.state === 'failed') continue
		const touching = later.flatMap((t) => {
			const e = t.entries.find((x) => samePath(x.path, entry.path) && x.state !== 'failed')
			// An edit still in flight has no after yet: it stands in the way too.
			return e && (e.state === 'pending' || !sameRef(e.before, e.after))
				? [{ turn: t, entry: e }]
				: []
		})
		const row = (turnId: string, e: PlanEntry, step: Step, cur: DiskState, extra?: object) => {
			files.push({
				turnId,
				path: e.path,
				rel: e.rel,
				action: step.action,
				...(step.reason ? { reason: step.reason } : {}),
				cur: diskToken(cur, compareMode),
				...extra,
			})
		}
		const disk = stateOf(entry.path)

		if (touching.length === 0) {
			row(target.turnId, entry, decide(entry, disk, compareMode), disk)
			continue
		}

		if (!input.alsoUndoLater) {
			// A later reply built on this one: undoing under it would pull the rug.
			// A chain the operator has already broken is left to the disk to judge.
			const blocked = chainIntact(touching, entry)
			row(
				target.turnId,
				entry,
				blocked
					? { action: 'conflict', reason: 'later-reply', next: disk }
					: decide(entry, disk, compareMode),
				disk,
				blocked ? { blockedBy: touching.map((t) => t.turn.turnId) } : undefined,
			)
			continue
		}

		// Newest first, each step checked against what the one before it leaves.
		let sim = disk
		let broken: string | undefined
		const chain = [...touching].reverse()
		for (const link of chain) {
			involved.add(link.turn.turnId)
			if (broken !== undefined) {
				row(
					link.turn.turnId,
					link.entry,
					{ action: 'conflict', reason: 'later-reply', next: sim },
					sim,
					{
						blockedBy: [broken],
					},
				)
				continue
			}
			const step = decide(link.entry, sim, compareMode)
			row(link.turn.turnId, link.entry, step, sim)
			if (step.action === 'conflict') broken = link.turn.turnId
			else sim = step.next
		}
		if (broken !== undefined) {
			row(target.turnId, entry, { action: 'conflict', reason: 'later-reply', next: sim }, sim, {
				blockedBy: [broken],
			})
		} else {
			row(target.turnId, entry, decide(entry, sim, compareMode), sim)
		}
	}

	// Later replies undo first.
	const order = new Map<string, number>()
	for (const t of input.turns) order.set(t.turnId, t.seq)
	const stable = files
		.map((f, i) => ({ f, i }))
		.sort((a, b) => (order.get(b.f.turnId) ?? 0) - (order.get(a.f.turnId) ?? 0) || a.i - b.i)
		.map((x) => x.f)

	const token = createHash('sha256')
		.update(
			JSON.stringify({
				turnId: target.turnId,
				alsoUndoLater: input.alsoUndoLater,
				turns: [...involved]
					.sort()
					.map((id) => [id, input.turns.find((t) => t.turnId === id)?.status]),
				files: stable.map((f) => [
					f.turnId,
					f.path,
					f.action,
					f.reason ?? null,
					f.cur,
					f.blockedBy ?? null,
				]),
			}),
		)
		.digest('hex')

	return {
		turnId: target.turnId,
		alsoUndoLater: input.alsoUndoLater,
		planToken: token,
		files: stable,
	}
}

/** The nearest later reply started from where this turn left the file. */
function chainIntact(
	touching: readonly { turn: PlanTurn; entry: PlanEntry }[],
	entry: PlanEntry,
): boolean {
	const nearest = touching[0]
	if (nearest?.entry.state === 'pending') return true
	return nearest !== undefined && sameRef(nearest.entry.before, entry.after)
}
