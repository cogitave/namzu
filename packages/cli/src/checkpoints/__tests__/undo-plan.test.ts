import { describe, expect, it } from 'vitest'

import type { BlobRef } from '../manifest.js'
import { type DiskState, type PlanEntry, type PlanTurn, diskToken, planUndo } from '../undo-plan.js'

// The decision table, with no filesystem: manifests and disk states in, a plan out.

const ref = (name: string, mode = 0o644): BlobRef => ({
	sha256: name.padEnd(64, '0'),
	size: name.length,
	mode,
})
const file = (name: string, mode = 0o644): DiskState => ({
	kind: 'file',
	sha256: name.padEnd(64, '0'),
	mode,
})
const absent: DiskState = { kind: 'absent' }

function entry(
	before: string | null,
	after: string | null,
	extra: Partial<PlanEntry> = {},
): PlanEntry {
	return {
		path: '/p/a.txt',
		rel: 'a.txt',
		before: before === null ? null : ref(before),
		after: after === null ? null : ref(after),
		state: 'done',
		beforeMissing: false,
		...extra,
	}
}

function turn(
	id: string,
	seq: number,
	entries: PlanEntry[],
	extra: Partial<PlanTurn> = {},
): PlanTurn {
	return { turnId: id, seq, status: 'applied', pruned: false, entries, ...extra }
}

const plan = (
	turns: PlanTurn[],
	disk: DiskState,
	extra: { alsoUndoLater?: boolean; turnId?: string } = {},
) =>
	planUndo({
		turnId: extra.turnId ?? turns[0]?.turnId ?? '',
		alsoUndoLater: extra.alsoUndoLater ?? false,
		turns,
		disk: new Map([['/p/a.txt', disk]]),
	})

describe('the decision table', () => {
	it('restores the before body when the disk still holds what the turn wrote', () => {
		const p = plan([turn('t1', 1, [entry('v0', 'v1')])], file('v1'))
		expect(p.files).toMatchObject([{ turnId: 't1', action: 'restore' }])
	})

	it('deletes a file the turn created, only while it is what the turn wrote', () => {
		const t = [turn('t1', 1, [entry(null, 'v1')])]
		expect(plan(t, file('v1')).files[0]?.action).toBe('delete')
		const drifted = plan(t, file('mine'))
		expect(drifted.files[0]).toMatchObject({ action: 'conflict', reason: 'drifted' })
	})

	it('treats a file created and then edited in one turn as one created file', () => {
		// One entry per path per turn: the first before, the last after.
		expect(plan([turn('t1', 1, [entry(null, 'v3')])], file('v3')).files[0]?.action).toBe('delete')
	})

	it('is a noop when the disk already holds the before state, which makes a rerun safe', () => {
		expect(plan([turn('t1', 1, [entry('v0', 'v1')])], file('v0')).files[0]?.action).toBe('noop')
		expect(plan([turn('t1', 1, [entry(null, 'v1')])], absent).files[0]?.action).toBe('noop')
	})

	it('conflicts as unavailable when the body to write back is gone, and writes nothing', () => {
		const t = [turn('t1', 1, [entry('v0', 'v1', { beforeMissing: true })])]
		expect(plan(t, file('v1')).files[0]).toMatchObject({
			action: 'conflict',
			reason: 'unavailable',
		})
		// Nothing to write: the file is already as undo would leave it.
		expect(plan(t, file('v0')).files[0]?.action).toBe('noop')
	})

	it('conflicts on a still-pending entry: the call may or may not have written', () => {
		const t = [turn('t1', 1, [entry('v0', null, { state: 'pending' })])]
		expect(plan(t, file('v1')).files[0]).toMatchObject({
			action: 'conflict',
			reason: 'unavailable',
		})
	})

	it('conflicts on a symlink, a directory and a path that left the project', () => {
		const t = [turn('t1', 1, [entry('v0', 'v1')])]
		expect(plan(t, { kind: 'symlink' }).files[0]).toMatchObject({ reason: 'symlink' })
		expect(plan(t, { kind: 'other' }).files[0]).toMatchObject({ reason: 'drifted' })
		expect(plan(t, { kind: 'outside' }).files[0]).toMatchObject({ reason: 'outside-cwd' })
	})

	it('conflicts on anything else, so the operator edit is never overwritten', () => {
		const t = [turn('t1', 1, [entry('v0', 'v1')])]
		expect(plan(t, file('operator'))).toMatchObject({
			files: [{ action: 'conflict', reason: 'drifted' }],
		})
		expect(plan(t, absent).files[0]).toMatchObject({ action: 'conflict', reason: 'drifted' })
	})

	it('treats a mode-only change after the reply as drift', () => {
		const t = [turn('t1', 1, [entry('v0', 'v1')])]
		expect(plan(t, file('v1', 0o755)).files[0]).toMatchObject({
			action: 'conflict',
			reason: 'drifted',
		})
		// Where permission bits are not the file's own, content decides.
		const p = planUndo({
			turnId: 't1',
			alsoUndoLater: false,
			turns: t,
			disk: new Map([['/p/a.txt', file('v1', 0o755)]]),
			compareMode: false,
		})
		expect(p.files[0]?.action).toBe('restore')
	})

	it('skips an entry whose call failed without changing anything', () => {
		const t = [turn('t1', 1, [entry('v0', 'v0', { state: 'failed' })])]
		expect(plan(t, file('v0')).files).toEqual([])
	})
})

describe('later replies', () => {
	const chain = () => [turn('t1', 1, [entry('v0', 'v1')]), turn('t2', 2, [entry('v1', 'v2')])]

	it('refuses a file a later reply built on, by default', () => {
		const p = plan(chain(), file('v2'), { turnId: 't1' })
		expect(p.files).toMatchObject([
			{ turnId: 't1', action: 'conflict', reason: 'later-reply', blockedBy: ['t2'] },
		])
	})

	it('undoes later replies first, newest first, when asked', () => {
		const t = [...chain(), turn('t3', 3, [entry('v2', 'v3')])]
		const p = plan(t, file('v3'), { turnId: 't1', alsoUndoLater: true })
		expect(p.files.map((f) => [f.turnId, f.action])).toEqual([
			['t3', 'restore'],
			['t2', 'restore'],
			['t1', 'restore'],
		])
	})

	it('stops the chain at the first step the disk does not support', () => {
		const t = [...chain(), turn('t3', 3, [entry('v2', 'v3')])]
		const p = plan(t, file('operator'), { turnId: 't1', alsoUndoLater: true })
		expect(p.files.map((f) => [f.turnId, f.action, f.reason])).toEqual([
			['t3', 'conflict', 'drifted'],
			['t2', 'conflict', 'later-reply'],
			['t1', 'conflict', 'later-reply'],
		])
	})

	it('does not count a later reply that has itself been undone', () => {
		// Undone newer first, then the older: the file is back at v1.
		const t = [
			turn('t1', 1, [entry('v0', 'v1')]),
			turn('t2', 2, [entry('v1', 'v2')], { status: 'undone' }),
		]
		const p = plan(t, file('v1'), { turnId: 't1' })
		expect(p.files[0]?.action).toBe('restore')
	})

	it('ignores a later reply whose edit changed nothing', () => {
		const t = [turn('t1', 1, [entry('v0', 'v1')]), turn('t2', 2, [entry('v1', 'v1')])]
		expect(plan(t, file('v1'), { turnId: 't1' }).files[0]?.action).toBe('restore')
	})

	it('leaves the disk to judge when the operator broke the chain', () => {
		// t2 started from something other than what t1 left.
		const t = [turn('t1', 1, [entry('v0', 'v1')]), turn('t2', 2, [entry('other', 'v2')])]
		expect(plan(t, file('v2'), { turnId: 't1' }).files[0]).toMatchObject({
			action: 'conflict',
			reason: 'drifted',
		})
	})

	it('ignores expired later turns', () => {
		const t = [
			turn('t1', 1, [entry('v0', 'v1')]),
			turn('t2', 2, [entry('v1', 'v2')], { pruned: true }),
		]
		expect(plan(t, file('v1'), { turnId: 't1' }).files[0]?.action).toBe('restore')
	})
})

describe('planToken', () => {
	const t = [turn('t1', 1, [entry('v0', 'v1')])]

	it('is stable for the same manifests and disk', () => {
		expect(plan(t, file('v1')).planToken).toBe(plan(t, file('v1')).planToken)
	})

	it('changes when the disk moves, the status moves, or the option moves', () => {
		const base = plan(t, file('v1')).planToken
		expect(plan(t, file('operator')).planToken).not.toBe(base)
		expect(
			plan(
				[turn('t1', 1, t[0]?.entries as PlanEntry[], { status: 'partially_undone' })],
				file('v1'),
			).planToken,
		).not.toBe(base)
		expect(plan(t, file('v1'), { alsoUndoLater: true }).planToken).not.toBe(base)
	})

	it('names disk states distinctly', () => {
		const tokens = [
			absent,
			file('a'),
			file('a', 0o600),
			{ kind: 'symlink' },
			{ kind: 'other' },
			{ kind: 'outside' },
		].map((s) => diskToken(s as DiskState))
		expect(new Set(tokens).size).toBe(tokens.length)
	})
})

it('refuses a turn it has no history for', () => {
	expect(() => plan([], absent, { turnId: 'nope' })).toThrow(/No file history/)
})
