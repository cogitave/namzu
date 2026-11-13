import type { SessionRecord } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { settleLine } from '../agent-transcript-rows.js'
import { trailFromRecords } from '../restored-rows.js'

const TURN = '00000000-0000-4000-8000-000000000001'
const CHILD_A = '00000000-0000-4000-8000-0000000000a1'
const CHILD_B = '00000000-0000-4000-8000-0000000000a2'

let seq = 0
const record = (fields: Record<string, unknown>): SessionRecord =>
	({
		v: 1,
		id: `r-${++seq}`,
		seq,
		ts: '2026-10-24T10:00:00.000Z',
		...fields,
	}) as unknown as SessionRecord

const spawned = (child: string) =>
	record({ type: 'child_session_spawned', turnId: TURN, childSessionId: child })
// The record leaves the turn out once the turn has closed: the spawn names it.
const ended = (child: string, tokens: number) =>
	record({ type: 'child_session_ended', childSessionId: child, usage: { totalTokens: tokens } })

describe('what a reopened turn says its agents spent', () => {
	it('adds up what the agents recorded as they ended, whichever turn state they ended in', () => {
		const trail = trailFromRecords([
			record({ type: 'turn_started', turnId: TURN }),
			spawned(CHILD_A),
			spawned(CHILD_B),
			ended(CHILD_A, 525),
			ended(CHILD_B, 1000),
		])
		expect(trail.turns.get(TURN)?.agentTokens).toBe(1525)
	})

	it('says nothing when no agent recorded an end', () => {
		const trail = trailFromRecords([
			record({ type: 'turn_started', turnId: TURN }),
			spawned(CHILD_A),
		])
		expect(trail.turns.get(TURN)?.agentTokens).toBeUndefined()
	})

	it('puts the total on the closing line the way the live run does', () => {
		const agents = [{ status: 'completed' }, { status: 'completed' }] as never
		const at = new Date('2026-10-24T10:00:05.000Z')
		const live = settleLine(
			5000,
			[
				{ status: 'completed', tokens: 525 },
				{ status: 'completed', tokens: 1000 },
			] as never,
			at,
		)
		expect(settleLine(5000, agents, at, 1525)).toBe(live)
		expect(live).toContain('1.5k tokens')
		expect(settleLine(5000, agents, at)).not.toContain('tokens')
	})
})
