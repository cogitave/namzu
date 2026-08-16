import { describe, expect, it, vi } from 'vitest'

import type { LLMProvider, StreamChunk } from '../../types/provider/index.js'
import type { Logger } from '../../utils/logger.js'
import { withProviderRetry } from '../retry.js'

/**
 * A backoff used to produce no signal of any kind. With the default policy
 * — three retries, a 16s cap — or a server-directed delay up to the 60s
 * ceiling, a run can sit silent for the better part of a minute between
 * `iteration_started` and the next event. A non-CLI host saw nothing and
 * got no keepalive, so its watchdog cancelled a run that was about to
 * succeed; on the CLI the spinner kept moving, which made a backoff
 * indistinguishable from a hang rather than visibly frozen.
 *
 * The omission was never principled: `tool_progress` exists precisely to
 * answer "is it still working?", and the wire contract justifies the
 * reasoning events on exactly the same grounds.
 */

function makeLogger(): Logger & { warns: unknown[][] } {
	const warns: unknown[][] = []
	const self = {
		warns,
		info: vi.fn(),
		warn: (...args: unknown[]) => warns.push(args),
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger & { warns: unknown[][] }
	;(self as unknown as { child: () => Logger }).child = () => self
	return self
}

/** A driver that fails `failures` times with a retryable error, then succeeds. */
function flakyProvider(failures: number, error?: unknown): LLMProvider {
	let attempts = 0
	return {
		id: 'test',
		name: 'Test',
		capabilities: {},
		async *chatStream(): AsyncIterable<StreamChunk> {
			if (attempts++ < failures) {
				throw error ?? Object.assign(new Error('service unavailable'), { status: 503 })
			}
			yield { id: 'c1', delta: { content: 'ok' } }
		},
	} as unknown as LLMProvider
}

async function drainChunks(provider: LLMProvider): Promise<StreamChunk[]> {
	const chunks: StreamChunk[] = []
	for await (const chunk of provider.chatStream({ model: 'm', messages: [] } as never)) {
		chunks.push(chunk)
	}
	return chunks
}

describe('a retry announces itself', () => {
	const sleepFn = async () => {}

	it('yields a notice before each backoff', async () => {
		const wrapped = withProviderRetry(flakyProvider(2), { sleepFn, random: () => 0.5 })
		const chunks = await drainChunks(wrapped)

		const notices = chunks.filter((c) => c.retry)
		expect(notices).toHaveLength(2)
		expect(notices[0]?.retry?.attempt).toBe(1)
		expect(notices[1]?.retry?.attempt).toBe(2)
	})

	it('carries the classification, not just the fact', async () => {
		const wrapped = withProviderRetry(flakyProvider(1), { sleepFn, random: () => 0.5 })
		const notice = (await drainChunks(wrapped)).find((c) => c.retry)?.retry

		// A host deciding whether to keep waiting needs to know what went
		// wrong and for how long, which is what a bare "retrying" cannot say.
		expect(notice?.status).toBe(503)
		expect(notice?.code).toBeTruthy()
		expect(notice?.delayMs).toBeGreaterThan(0)
		expect(notice?.maxRetries).toBe(3)
	})

	it('names a server-directed delay as such', async () => {
		const directed = Object.assign(new Error('slow down'), {
			status: 429,
			headers: { 'retry-after': '2' },
		})
		const wrapped = withProviderRetry(flakyProvider(1, directed), { sleepFn, random: () => 0.5 })
		const notice = (await drainChunks(wrapped)).find((c) => c.retry)?.retry

		expect(notice?.serverDirected).toBe(true)
		expect(notice?.delayMs).toBe(2000)
	})

	it('carries no delta, so it is never mistaken for output', async () => {
		const wrapped = withProviderRetry(flakyProvider(1), { sleepFn, random: () => 0.5 })
		const notice = (await drainChunks(wrapped)).find((c) => c.retry)

		expect(notice?.delta).toEqual({})
		expect(notice?.finishReason).toBeUndefined()
	})

	it('is emitted BEFORE the sleep, so the delay it names is still ahead', async () => {
		const order: string[] = []
		const wrapped = withProviderRetry(flakyProvider(1), {
			sleepFn: async () => {
				order.push('slept')
			},
			random: () => 0.5,
		})

		for await (const chunk of wrapped.chatStream({ model: 'm', messages: [] } as never)) {
			if (chunk.retry) order.push('notice')
		}

		// Reversed, this tells the host about a wait that is already over.
		expect(order).toEqual(['notice', 'slept'])
	})

	it('says nothing when the call succeeds first time', async () => {
		const wrapped = withProviderRetry(flakyProvider(0), { sleepFn })
		expect((await drainChunks(wrapped)).some((c) => c.retry)).toBe(false)
	})

	it('says nothing more once it gives up', async () => {
		const wrapped = withProviderRetry(flakyProvider(99), {
			sleepFn,
			config: { maxRetries: 2 },
			random: () => 0.5,
		})

		const chunks: StreamChunk[] = []
		await expect(async () => {
			for await (const chunk of wrapped.chatStream({ model: 'm', messages: [] } as never)) {
				chunks.push(chunk)
			}
		}).rejects.toThrow()

		// Two notices for two retries, then the throw — not a third notice
		// promising a backoff that never happens.
		expect(chunks.filter((c) => c.retry)).toHaveLength(2)
	})
})

describe('the logger the sole production call site never passed', () => {
	it('warns on a retry when it is given one', async () => {
		// Every warn in the decorator is guarded behind `options.log`, and
		// production never supplied it — so these lines were dead code and a
		// backoff left no trace anywhere at all.
		const log = makeLogger()
		const wrapped = withProviderRetry(flakyProvider(1), {
			sleepFn: async () => {},
			random: () => 0.5,
			log,
		})
		await drainChunks(wrapped)

		expect(log.warns.some(([message]) => String(message).includes('retrying'))).toBe(true)
	})
})
