import { type Attributes, type Meter, metrics } from '@opentelemetry/api'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetRuntimeMetrics } from '../../../../telemetry/metrics.js'
import type { RunId } from '../../../../types/ids/index.js'
import type { ChatCompletionParams, StreamChunk } from '../../../../types/provider/index.js'
import type { LLMProvider } from '../../../../types/provider/interface.js'
import type { RunEvent } from '../../../../types/run/index.js'
import type { Logger } from '../../../../utils/logger.js'
import { streamProviderTurn } from '../stream-turn.js'

/**
 * Cancel re-threw from inside the chunk loop, so everything past it was
 * unreachable: the usage merged so far was discarded wholesale, the span
 * opened for the call was never ended, and the message the turn announced
 * never got a terminator.
 *
 * The load-bearing consequence is silent cost under-reporting — a cancelled
 * turn is not a free turn; the tokens were spent. The stream-ERROR path a
 * few lines away already settled all of this, so cancel was the one exit
 * that skipped it, which is the opposite of what its frequency deserves.
 */

const RUN_ID = 'run_cancel' as RunId

interface Written {
	instrument: string
	value: number
	attributes: Attributes
}

function captureMetrics(written: Written[]) {
	const instrument = (name: string) => ({
		add: (value: number, attributes: Attributes = {}) =>
			written.push({ instrument: name, value, attributes }),
		record: (value: number, attributes: Attributes = {}) =>
			written.push({ instrument: name, value, attributes }),
	})
	const meter = {
		createCounter: (n: string) => instrument(n),
		createHistogram: (n: string) => instrument(n),
		createUpDownCounter: (n: string) => instrument(n),
		createObservableGauge: (n: string) => instrument(n),
		createObservableCounter: (n: string) => instrument(n),
		createObservableUpDownCounter: (n: string) => instrument(n),
		addBatchObservableCallback: () => {},
		removeBatchObservableCallback: () => {},
	} as unknown as Meter
	metrics.setGlobalMeterProvider({ getMeter: () => meter })
}

function makeLogger(): Logger {
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

/** Streams a little, then blocks until the caller aborts. */
function stallingProvider(controller: AbortController): LLMProvider {
	return {
		id: 'stalling',
		name: 'stalling',
		capabilities: { supportsTools: true, supportsStreaming: true, supportsFunctionCalling: true },
		async *chatStream(): AsyncIterable<StreamChunk> {
			yield { id: 'm1', delta: { content: 'partial answer' } }
			yield {
				id: 'm1',
				delta: {},
				usage: {
					promptTokens: 1_200,
					completionTokens: 340,
					totalTokens: 1_540,
					cachedTokens: 500,
					cacheWriteTokens: 40,
				},
			}
			controller.abort()
			// The runtime checks the signal between chunks.
			yield { id: 'm1', delta: { content: 'never seen' } }
		},
		async listModels() {
			return []
		},
		async healthCheck() {
			return true
		},
	}
}

async function runCancelled(): Promise<{ events: RunEvent[]; written: Written[] }> {
	const written: Written[] = []
	captureMetrics(written)

	const controller = new AbortController()
	const events: RunEvent[] = []
	const params = {
		model: 'cancel-model',
		messages: [{ role: 'user' as const, content: 'hi' }],
		signal: controller.signal,
	} as ChatCompletionParams

	const iterator = streamProviderTurn(
		stallingProvider(controller),
		params,
		async (e: RunEvent) => {
			events.push(e)
		},
		function* () {},
		RUN_ID,
		1,
		false,
		makeLogger(),
	)

	await expect(
		(async () => {
			for (;;) {
				const next = await iterator.next()
				if (next.done) return next.value
				events.push(next.value)
			}
		})(),
	).rejects.toThrow()

	return { events, written }
}

beforeEach(() => {
	resetRuntimeMetrics()
})

afterEach(() => {
	metrics.disable()
	resetRuntimeMetrics()
})

describe('a turn cancelled mid-stream', () => {
	it('records the tokens it already spent', async () => {
		const { written } = await runCancelled()
		const tokens = written.filter((w) => w.instrument === 'gen_ai.client.token.usage')

		// A cancelled turn is not a free turn. Discarding the accumulated
		// usage under-reports the cost of every cancellation.
		expect(tokens.length).toBeGreaterThan(0)
		expect(tokens.reduce((sum, w) => sum + w.value, 0)).toBe(1_200 + 340 + 500 + 40)
	})

	it('records how long the call ran before it was stopped', async () => {
		const { written } = await runCancelled()
		expect(written.some((w) => w.instrument === 'gen_ai.client.operation.duration')).toBe(true)
	})

	it('closes the message it announced', async () => {
		const { events } = await runCancelled()
		const completed = events.find((e) => e.type === 'message_completed') as
			| { stopReason?: string; content?: string }
			| undefined

		// A host consuming the message lifecycle saw a message begin and
		// never end.
		expect(completed).toBeDefined()
		expect(completed?.stopReason).toBe('cancelled')
	})

	it('keeps the text the model had already produced', async () => {
		const { events } = await runCancelled()
		const completed = events.find((e) => e.type === 'message_completed') as
			| { content?: string }
			| undefined
		expect(completed?.content).toBe('partial answer')
	})

	it('still propagates the cancellation', async () => {
		// Settling the bookkeeping must not swallow the reason the turn
		// ended — the run loop needs the throw to settle as cancelled.
		await expect(runCancelled()).resolves.toBeDefined()
	})
})
