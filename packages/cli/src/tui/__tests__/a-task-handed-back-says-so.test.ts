/**
 * What a person sees when the model handed the task back: the kernel's line
 * saying so and why, and under it the model's own three sentences, each
 * labelled as the model's. A reopened conversation draws the same lines from
 * the saved call, and a refused call draws none.
 */
import {
	HAND_BACK_RECEIPT,
	HAND_BACK_TOOL_NAME,
	type Message,
	type SessionRecord,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { handedBackLines } from '../outcome-line.js'
import { trailFromRecords } from '../restored-rows.js'

const SESSION = '00000000-0000-4000-8000-0000000000cc'
const TURN = '00000000-0000-4000-8000-000000000301'

const handBack = {
	kind: 'missing',
	blocker: 'there is no key for the service',
	tried: 'looked in the config and the environment',
	needed: 'provide a key',
} as const

describe('the closing lines of a task handed back', () => {
	it('says it in the kernel words and keeps the model words apart and labelled', () => {
		const lines = handedBackLines(handBack)
		expect(lines?.line).toBe(
			'The model handed the task back to a person: something needed is missing or not allowed.',
		)
		expect(lines?.line).not.toContain('no key')
		expect(lines?.model).toEqual([
			'The model says it is blocked by: there is no key for the service',
			'It tried: looked in the config and the environment',
			'It needs a person to: provide a key',
		])
	})

	it('makes control characters in the model words printable', () => {
		const lines = handedBackLines({ ...handBack, blocker: 'a\u001b[31mred\u0007 thing' })
		expect([...(lines?.model[0] ?? '')].some((ch) => ch.charCodeAt(0) < 32)).toBe(false)
	})

	it('says nothing when the turn was not handed back', () => {
		expect(handedBackLines(undefined)).toBeUndefined()
	})
})

function reopened(receipt: string): string[] {
	const user = { ...createUserMessage('make it work'), id: 'u-1' } as Message
	const call = {
		...createAssistantMessage(''),
		id: 'a-1',
		toolCalls: [
			{
				id: 'call-1',
				type: 'function',
				function: { name: HAND_BACK_TOOL_NAME, arguments: JSON.stringify(handBack) },
			},
		],
	} as unknown as Message
	const result = {
		role: 'tool',
		id: 't-1',
		toolCallId: 'call-1',
		content: receipt,
		timestamp: 1,
	} as unknown as Message
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
	for (const m of [user, call, result])
		push({ type: 'message', turnId: TURN, messageId: m.id, role: m.role, content: m })
	push({ type: 'turn_completed', turnId: TURN, result: '' })
	let n = 0
	return projectConversation([user, call, result], () => `row-${++n}`, [], {
		trail: trailFromRecords(records),
	}).map((row) => row.content)
}

describe('a reopened conversation and a task handed back', () => {
	it('draws the same lines from the saved call', () => {
		const rows = reopened(`${HAND_BACK_RECEIPT} The turn ends now.`)
		expect(rows).toContain(
			'The model handed the task back to a person: something needed is missing or not allowed.',
		)
		expect(rows).toContain('It needs a person to: provide a key')
	})

	it('draws nothing for a call the kernel refused', () => {
		const rows = reopened('Tool hand_back_task failed: the hand-back needs a kind.')
		expect(rows.join('\n')).not.toContain('handed the task back')
	})
})
