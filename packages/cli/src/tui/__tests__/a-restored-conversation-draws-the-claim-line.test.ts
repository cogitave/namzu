/**
 * The line under the outcome line that says the answer and the record
 * disagree is worked out from the answer and the record, both of which the
 * session log holds. A reopened conversation draws the same line as the live
 * one, and none where there is no mismatch.
 */
import {
	type Message,
	type SessionRecord,
	type TurnOutcome,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { trailFromRecords } from '../restored-rows.js'

const SESSION = '00000000-0000-4000-8000-0000000000bb'
const TURN = '00000000-0000-4000-8000-000000000201'

const failing: TurnOutcome = {
	verdict: 'failing',
	basis: 'calls',
	changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false },
	checks: [{ command: 'pnpm test', step: 1, result: 'failed', exitCode: 1 }],
}
const passing: TurnOutcome = {
	...failing,
	verdict: 'checked',
	checks: [{ command: 'pnpm test', step: 1, result: 'passed', exitCode: 0 }],
}

function reopened(answer: string, outcome: TurnOutcome): string[] {
	const user = { ...createUserMessage('fix it'), id: 'u-1' } as Message
	const reply = { ...createAssistantMessage(answer), id: 'a-1' } as Message
	const records: SessionRecord[] = []
	let seq = 0
	const push = (r: Record<string, unknown>) =>
		records.push({
			v: 1,
			id: `r-${seq}`,
			seq: seq++,
			ts: '2026-11-12T10:00:00.000Z',
			sessionId: SESSION,
			...r,
		} as unknown as SessionRecord)
	push({ type: 'turn_started', turnId: TURN })
	for (const m of [user, reply])
		push({ type: 'message', turnId: TURN, messageId: m.id, role: m.role, content: m })
	push({ type: 'turn_outcome_recorded', turnId: TURN, ignorable: true, outcome })
	push({ type: 'turn_completed', turnId: TURN, result: '' })
	let n = 0
	return projectConversation([user, reply], () => `row-${++n}`, [], {
		trail: trailFromRecords(records),
	}).map((row) => row.content)
}

describe('a reopened conversation and the claim line', () => {
	it('draws the line when the saved answer and record disagree', () => {
		const rows = reopened('All tests pass.', failing)
		expect(rows).toContain('The answer says the tests pass. The record: pnpm test failed.')
	})

	it('draws nothing when the record agrees or the answer claims nothing', () => {
		expect(reopened('All tests pass.', passing).join('\n')).not.toContain('The answer says')
		expect(reopened('I changed the retry count.', failing).join('\n')).not.toContain(
			'The answer says',
		)
	})
})
