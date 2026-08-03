import { describe, expect, it, vi } from 'vitest'

import type { RunId } from '../../../types/ids/index.js'
import type { LLMProvider, StreamChunk } from '../../../types/provider/index.js'
import { isEphemeralEvent } from '../../../types/run/events.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { Logger } from '../../../utils/logger.js'
import { streamProviderTurn } from '../iteration/stream-turn.js'

/**
 * Reasoning had no channel at all: `StreamChunk.delta` carried only
 * `content` / `toolCalls`, so `thinking_delta` and `signature_delta` fell
 * through the driver's `default: // ignore` and the blocks could
 * not be stored even in principle. Two consequences — the verbatim-echo
 * contract was unsatisfiable, and a streaming UI showed a multi-second
 * stall with zero events while the model was demonstrably working.
 */

const RUN_ID = 'run_reasoning' as RunId

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function providerOf(chunks: StreamChunk[]): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		chatStream: async function* () {
			for (const c of chunks) yield c
		},
	} as unknown as LLMProvider
}

/** Drive the turn, collecting every event it emits. */
async function run(chunks: StreamChunk[]) {
	const events: RunEvent[] = []
	const pending: RunEvent[] = []
	const emitEvent = async (e: RunEvent) => {
		events.push(e)
		pending.push(e)
	}
	const drainPending = function* (): Generator<RunEvent> {
		while (pending.length > 0) {
			const next = pending.shift()
			if (next) yield next
		}
	}

	const gen = streamProviderTurn(
		providerOf(chunks),
		{ model: 'm', messages: [] } as never,
		emitEvent,
		drainPending,
		RUN_ID,
		1,
		false,
		makeLogger(),
	)
	let next = await gen.next()
	while (!next.done) next = await gen.next()
	return { result: next.value, events }
}

const finish = (): StreamChunk => ({
	id: 'c',
	delta: {},
	finishReason: 'stop',
	usage: {
		promptTokens: 1,
		completionTokens: 1,
		totalTokens: 2,
		cachedTokens: 0,
		cacheWriteTokens: 0,
	},
})

describe('reasoning blocks survive the stream', () => {
	it('accumulates fragments into one block and keeps the signature', async () => {
		const { result } = await run([
			{ id: 'c', delta: { reasoning: { index: 0, type: 'thinking' } } },
			{ id: 'c', delta: { reasoning: { index: 0, text: 'first ' } } },
			{ id: 'c', delta: { reasoning: { index: 0, text: 'second' } } },
			{ id: 'c', delta: { reasoning: { index: 0, signature: 'sig-xyz' } } },
			{ id: 'c', delta: { reasoning: { index: 0, done: true } } },
			{ id: 'c', delta: { content: 'answer' } },
			finish(),
		])

		expect(result.response.message.reasoning).toEqual([
			{ type: 'thinking', text: 'first second', signature: 'sig-xyz' },
		])
		expect(result.response.message.content).toBe('answer')
	})

	it('emits the started → delta → completed lifecycle', async () => {
		const { events } = await run([
			{ id: 'c', delta: { reasoning: { index: 0, type: 'thinking' } } },
			{ id: 'c', delta: { reasoning: { index: 0, text: 'hm' } } },
			{ id: 'c', delta: { reasoning: { index: 0, signature: 's' } } },
			{ id: 'c', delta: { reasoning: { index: 0, done: true } } },
			finish(),
		])

		const kinds = events.filter((e) => e.type.startsWith('reasoning_')).map((e) => e.type)
		expect(kinds).toEqual(['reasoning_started', 'reasoning_delta', 'reasoning_completed'])

		const completed = events.find((e) => e.type === 'reasoning_completed')
		expect(completed).toMatchObject({ text: 'hm', signed: true, blockIndex: 0 })
	})

	it('reports signed:false when the provider sent no signature', async () => {
		const { events } = await run([
			{ id: 'c', delta: { reasoning: { index: 0, type: 'thinking', text: 'x' } } },
			{ id: 'c', delta: { reasoning: { index: 0, done: true } } },
			finish(),
		])
		expect(events.find((e) => e.type === 'reasoning_completed')).toMatchObject({ signed: false })
	})

	it('keeps a redacted block by its opaque payload', async () => {
		const { result } = await run([
			{
				id: 'c',
				delta: { reasoning: { index: 0, type: 'redacted_thinking', encrypted: 'blob' } },
			},
			{ id: 'c', delta: { reasoning: { index: 0, done: true } } },
			finish(),
		])
		expect(result.response.message.reasoning).toEqual([
			{ type: 'redacted_thinking', encrypted: 'blob' },
		])
	})

	it('returns multiple blocks in stream-index order, not arrival order', async () => {
		// A provider that opens index 1 before index 0 must still replay in
		// block order — the echo contract is about the original ordering.
		const { result } = await run([
			{ id: 'c', delta: { reasoning: { index: 1, type: 'thinking', text: 'second' } } },
			{ id: 'c', delta: { reasoning: { index: 0, type: 'thinking', text: 'first' } } },
			{ id: 'c', delta: { reasoning: { index: 0, done: true } } },
			{ id: 'c', delta: { reasoning: { index: 1, done: true } } },
			finish(),
		])
		expect(result.response.message.reasoning?.map((b) => b.text)).toEqual(['first', 'second'])
	})

	it('omits `reasoning` entirely when the model emitted none', async () => {
		const { result } = await run([{ id: 'c', delta: { content: 'plain' } }, finish()])
		expect(result.response.message.reasoning).toBeUndefined()
	})

	it('marks reasoning_delta ephemeral so the transcript is not flooded', () => {
		expect(
			isEphemeralEvent({
				type: 'reasoning_delta',
				runId: RUN_ID,
				iteration: 1,
				messageId: 'msg_x',
				blockIndex: 0,
				text: 'x',
			} as unknown as RunEvent),
		).toBe(true)
		// The completed block carries the full text and IS recorded.
		expect(
			isEphemeralEvent({
				type: 'reasoning_completed',
				runId: RUN_ID,
				iteration: 1,
				messageId: 'msg_x',
				blockIndex: 0,
				signed: true,
			} as unknown as RunEvent),
		).toBe(false)
	})
})
