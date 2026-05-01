/**
 * Behavioural contract for `coalesce()` (ses_001-tool-stream-events phase 1A):
 *
 * - `text_delta` events for the same `messageId` within the configured
 *   `windowMs` are merged into a single event whose `text` is the
 *   concatenation in arrival order.
 * - `tool_input_delta` events for the same `toolUseId` within the window
 *   are merged the same way on `partialJson`.
 * - Any other event flushes pending buffers first, preserving overall
 *   stream ordering.
 * - End-of-stream flushes any remaining buffers.
 * - Different `messageId`s and `toolUseId`s never merge with each other.
 *
 * The coalescer is opt-in for slow downstream consumers (SSE adapters);
 * the orchestrator emits raw deltas. A 16ms default roughly aligns with
 * one 60fps animation frame.
 */

import { describe, expect, it } from 'vitest'

import type { MessageId, RunId, ToolUseId } from '../types/ids/index.js'
import type { RunEvent } from '../types/run/events.js'

import { coalesce } from './coalesce.js'

const RID = 'run_1' as RunId
const MID = 'msg_1' as MessageId
const MID2 = 'msg_2' as MessageId
const TUID: ToolUseId = 'toolu_a'
const TUID2: ToolUseId = 'toolu_b'

async function* fromArray(events: RunEvent[]): AsyncIterable<RunEvent> {
	for (const e of events) yield e
}

async function drain(stream: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
	const out: RunEvent[] = []
	for await (const e of stream) out.push(e)
	return out
}

describe('coalesce()', () => {
	it('merges consecutive text_delta events with same messageId within window', async () => {
		const events: RunEvent[] = [
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'hel' },
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'lo' },
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: ' world' },
		]
		const result = await drain(coalesce(fromArray(events), { windowMs: 1000 }))
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			type: 'text_delta',
			text: 'hello world',
			messageId: MID,
		})
	})

	it('merges consecutive tool_input_delta events with same toolUseId', async () => {
		const events: RunEvent[] = [
			{ type: 'tool_input_delta', runId: RID, toolUseId: TUID, partialJson: '{"file":' },
			{ type: 'tool_input_delta', runId: RID, toolUseId: TUID, partialJson: '"/a"' },
			{ type: 'tool_input_delta', runId: RID, toolUseId: TUID, partialJson: '}' },
		]
		const result = await drain(coalesce(fromArray(events), { windowMs: 1000 }))
		expect(result).toHaveLength(1)
		expect(result[0]).toMatchObject({
			type: 'tool_input_delta',
			toolUseId: TUID,
			partialJson: '{"file":"/a"}',
		})
	})

	it('does not merge across different messageIds', async () => {
		const events: RunEvent[] = [
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'a' },
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID2, text: 'b' },
		]
		const result = await drain(coalesce(fromArray(events), { windowMs: 1000 }))
		expect(result).toHaveLength(2)
	})

	it('does not merge across different toolUseIds', async () => {
		const events: RunEvent[] = [
			{ type: 'tool_input_delta', runId: RID, toolUseId: TUID, partialJson: 'x' },
			{ type: 'tool_input_delta', runId: RID, toolUseId: TUID2, partialJson: 'y' },
		]
		const result = await drain(coalesce(fromArray(events), { windowMs: 1000 }))
		expect(result).toHaveLength(2)
	})

	it('flushes pending buffers when a non-coalescable event arrives', async () => {
		const events: RunEvent[] = [
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'a' },
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'b' },
			{
				type: 'tool_input_started',
				runId: RID,
				iteration: 0,
				messageId: MID,
				toolUseId: TUID,
				toolName: 'Read',
			},
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'c' },
		]
		const result = await drain(coalesce(fromArray(events), { windowMs: 1000 }))
		expect(result.map((e) => e.type)).toEqual(['text_delta', 'tool_input_started', 'text_delta'])
		expect((result[0] as { text: string }).text).toBe('ab')
		expect((result[2] as { text: string }).text).toBe('c')
	})

	it('flushes residual buffers at end of stream', async () => {
		const events: RunEvent[] = [
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'tail' },
		]
		const result = await drain(coalesce(fromArray(events), { windowMs: 1000 }))
		expect(result).toHaveLength(1)
	})

	it('emits new event after window expires', async () => {
		const events: RunEvent[] = [
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'a' },
			{ type: 'text_delta', runId: RID, iteration: 0, messageId: MID, text: 'b' },
		]
		const stream: AsyncIterable<RunEvent> = (async function* () {
			yield events[0]!
			await new Promise((r) => setTimeout(r, 30))
			yield events[1]!
		})()
		const result = await drain(coalesce(stream, { windowMs: 16 }))
		expect(result).toHaveLength(2)
	})
})
