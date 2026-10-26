import { describe, expect, it } from 'vitest'

import { SESSION_RECORD_MAX_BYTES } from '../../../types/session/records.js'
import { eventDraft } from '../turn-recorder.js'

const call = (id: string, input: unknown) => ({ id, name: 'write', input, isDestructive: true })
const review = (toolCalls: ReturnType<typeof call>[]) =>
	({
		type: 'tool_review_requested',
		sessionId: 'ses_1',
		turnId: 'turn_1',
		toolCalls,
		iteration: 1,
	}) as never

describe('a review of many large calls', () => {
	it('stays under the record cap by cutting each oversized input to an excerpt', () => {
		const calls = Array.from({ length: 30 }, (_, i) =>
			call(`c${i}`, { path: `f${i}`, content: 'A'.repeat(150_000) }),
		)
		const draft = eventDraft(review(calls), undefined) as unknown as {
			toolCalls: { id: string; input: { truncated?: boolean; length?: number } }[]
		}
		expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThan(SESSION_RECORD_MAX_BYTES)
		expect(draft.toolCalls.map((c) => c.id)).toEqual(calls.map((c) => c.id))
		expect(draft.toolCalls[0]?.input.truncated).toBe(true)
		expect(draft.toolCalls[0]?.input.length).toBeGreaterThan(150_000)
	})

	it('keeps every input whole while the batch is small', () => {
		const calls = [call('c1', { content: 'x'.repeat(20_000) }), call('c2', { content: 'y' })]
		const draft = eventDraft(review(calls), undefined) as unknown as { toolCalls: unknown[] }
		expect(draft.toolCalls).toEqual(calls)
	})

	it('cuts one input that alone exceeds the record cap to an excerpt', () => {
		const event = {
			type: 'tool_input_completed',
			sessionId: 'ses_1',
			turnId: 'turn_1',
			toolUseId: 'tu_1',
			input: { path: 'big', content: 'A'.repeat(4_500_000) },
		} as never
		const draft = eventDraft(event, undefined) as unknown as {
			input: { truncated?: boolean; length?: number }
		}
		expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThan(SESSION_RECORD_MAX_BYTES)
		expect(draft.input.truncated).toBe(true)
		expect(draft.input.length).toBeGreaterThan(4_500_000)
	})

	it('cuts the input of an executing call that alone exceeds the record cap', () => {
		const event = {
			type: 'tool_executing',
			sessionId: 'ses_1',
			turnId: 'turn_1',
			toolUseId: 'tu_1',
			name: 'write',
			input: { path: 'big', content: 'A'.repeat(4_500_000) },
		} as never
		const draft = eventDraft(event, undefined) as unknown as {
			input: { truncated?: boolean; length?: number }
		}
		expect(Buffer.byteLength(JSON.stringify(draft))).toBeLessThan(SESSION_RECORD_MAX_BYTES)
		expect(draft.input.truncated).toBe(true)
	})
})
