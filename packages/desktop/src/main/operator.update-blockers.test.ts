import { afterEach, expect, it, vi } from 'vitest'
import type { BackgroundWorkStatus } from '../shared/background-work-protocol.js'
import { Operator } from './operator.js'

const owners: Operator[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const owner of owners) (owner as unknown as Inside).conversations.clear()
	await Promise.all(owners.splice(0).map((owner) => owner.close()))
})

interface Inside {
	conversations: Map<string, unknown>
	backgroundWork: { snapshot(): Record<string, BackgroundWorkStatus> }
}

function fixture(
	sessions: Record<
		string,
		{ running?: boolean; admitting?: boolean; queue?: number; permissions?: number }
	>,
	statuses: Record<string, BackgroundWorkStatus> = {},
) {
	const owner = new Operator({ program: process.execPath, args: [] }, () => {})
	owners.push(owner)
	const inside = owner as unknown as Inside
	for (const [id, value] of Object.entries(sessions))
		inside.conversations.set(id, {
			running: value.running ?? false,
			admitting: value.admitting ?? false,
			queue: new Array(value.queue ?? 0),
			permissions: new Map(
				Array.from({ length: value.permissions ?? 0 }, (_, i) => [String(i), {}]),
			),
		})
	vi.spyOn(inside.backgroundWork, 'snapshot').mockReturnValue(statuses)
	return owner
}

it('is clear when nothing is active and unknown background status is not a reason', () => {
	expect(
		fixture({ a: {} }, { a: { state: 'unknown' }, b: { state: 'unavailable' } }).updateBlockers(),
	).toEqual([])
})

it('names a running, admitting or queued turn once, however many conversations have one', () => {
	expect(
		fixture({ a: { running: true }, b: { admitting: true }, c: { queue: 2 } }).updateBlockers(),
	).toEqual(['turn-running'])
})

it('names a pending permission and running background work separately', () => {
	const known = {
		state: 'known',
		runningCount: 1,
		needsAttention: false,
		checkedAt: 0,
		expiresAt: 1,
	} as const
	expect(fixture({ a: { permissions: 1 } }, { a: known }).updateBlockers()).toEqual([
		'permission-pending',
		'background-work',
	])
	expect(fixture({}, { a: { ...known, runningCount: 0 } }).updateBlockers()).toEqual([])
})
