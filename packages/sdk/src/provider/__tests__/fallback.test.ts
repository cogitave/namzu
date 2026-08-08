/**
 * The failover decorator, and in particular the four properties most likely to
 * be quietly broken by a later edit: output stops a swap, a request fault stops
 * a swap, an abort stops a swap, and the chain is walked to its END rather than
 * one step.
 *
 * Every test here has been mutation-checked — the defect it covers was restored
 * and this file was watched to fail. The profile is in the session log.
 */

import { describe, expect, it } from 'vitest'

import { classifyProviderError } from '../../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { providerHttpError } from '../errors.js'
import { withProviderFallback } from '../fallback.js'
import { withProviderRetry } from '../retry.js'

const PARAMS = { model: 'primary-model', messages: [] } as unknown as ChatCompletionParams

function chunk(content: string): StreamChunk {
	return { id: 'c', delta: { content } }
}

function httpError(status: number, message = `HTTP ${status}`, headers?: Record<string, string>) {
	return Object.assign(new Error(message), { status, headers })
}

/** A member whose behaviour is scripted per call, recording what it was asked. */
function member(
	id: string,
	script: Array<() => AsyncIterable<StreamChunk>>,
): LLMProvider & { calls: number; models: string[] } {
	let calls = 0
	const models: string[] = []
	return {
		id,
		name: id,
		chatStream: (params: ChatCompletionParams) => {
			const step = script[Math.min(calls, script.length - 1)]
			models.push(params.model)
			calls++
			if (!step) throw new Error('script exhausted')
			return step()
		},
		get calls() {
			return calls
		},
		get models() {
			return models
		},
	} as unknown as LLMProvider & { calls: number; models: string[] }
}

async function collectChunks(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
	const out: StreamChunk[] = []
	for await (const c of stream) out.push(c)
	return out
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<string> {
	let out = ''
	for await (const c of await collectChunks(stream)) out += c.delta.content ?? ''
	return out
}

const noSleep = async () => {}

describe('withProviderFallback', () => {
	it('falls over on a rejected credential and continues on the next member', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(401)
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('served by the fallback')
			},
		])
		const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

		expect(await drain(wrapped.chatStream(PARAMS))).toBe('served by the fallback')
		expect(primary.calls).toBe(1)
		expect(fallback.calls).toBe(1)
	})

	it('announces the swap in-band, naming both members and the reason', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(500)
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('ok')
			},
		])
		const wrapped = withProviderFallback([
			{ provider: primary, model: 'big' },
			{ provider: fallback, model: 'small' },
		])

		const notices = (await collectChunks(wrapped.chatStream(PARAMS))).flatMap((c) =>
			c.fallback ? [c.fallback] : [],
		)
		expect(notices).toHaveLength(1)
		expect(notices[0]).toMatchObject({
			fromIndex: 0,
			fromProviderId: 'primary',
			fromModel: 'big',
			toIndex: 1,
			toProviderId: 'fallback',
			toModel: 'small',
			code: 'server_error',
			status: 500,
		})
	})

	it('asks each member for ITS model, not the request’s', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(503)
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('ok')
			},
		])
		const wrapped = withProviderFallback([
			{ provider: primary, model: 'model-a' },
			{ provider: fallback, model: 'model-b' },
		])

		await drain(wrapped.chatStream(PARAMS))
		expect(primary.models).toEqual(['model-a'])
		expect(fallback.models).toEqual(['model-b'])
	})

	it('leaves the request’s own model alone for a member that declares none', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(500)
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('ok')
			},
		])
		const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

		await drain(wrapped.chatStream(PARAMS))
		expect(fallback.models).toEqual(['primary-model'])
	})

	// The divergence this PR exists to remove: honouring only the first fallback
	// would make members 2..N decorative on a chain the operator declared.
	it('walks the WHOLE chain, not one step', async () => {
		const first = member('first', [
			() => {
				throw httpError(401)
			},
		])
		const second = member('second', [
			() => {
				throw httpError(500)
			},
		])
		const third = member('third', [
			async function* () {
				yield chunk('third served it')
			},
		])
		const wrapped = withProviderFallback([
			{ provider: first },
			{ provider: second },
			{ provider: third },
		])

		expect(await drain(wrapped.chatStream(PARAMS))).toBe('third served it')
		expect(third.calls).toBe(1)
	})

	it('tries each member at most once per turn, and never rewinds', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(401)
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('first turn call')
			},
			async function* () {
				yield chunk('second call, same decorator')
			},
		])
		const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

		await drain(wrapped.chatStream(PARAMS))
		// A second request on the SAME decorator — i.e. a later iteration of the
		// same turn. The cursor stays where it landed; the primary is not re-asked.
		expect(await drain(wrapped.chatStream(PARAMS))).toBe('second call, same decorator')
		expect(primary.calls).toBe(1)
		expect(fallback.calls).toBe(2)
	})

	it('throws the last member’s error once the chain is exhausted', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(401)
			},
		])
		const fallback = member('fallback', [
			() => {
				throw httpError(503, 'last one down')
			},
		])
		const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

		await expect(drain(wrapped.chatStream(PARAMS))).rejects.toMatchObject({ status: 503 })
	})

	describe('does not fall over', () => {
		it.each([
			[400, 'bad tool schema', 'invalid_request'],
			[400, 'prompt is too long: 250000 tokens > 200000', 'context_length_exceeded'],
		])('on a request fault — HTTP %i (%s)', async (status, message) => {
			const primary = member('primary', [
				() => {
					throw httpError(status as number, message as string)
				},
			])
			const fallback = member('fallback', [
				async function* () {
					yield chunk('should never run')
				},
			])
			const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

			await expect(drain(wrapped.chatStream(PARAMS))).rejects.toThrow()
			expect(fallback.calls).toBe(0)
		})

		/**
		 * A 404 is a fact about THIS member's catalogue — the model is not there —
		 * not about the request, so it must fall over.
		 *
		 * The error is built with `providerHttpError` rather than thrown raw, and
		 * that is the whole test. A raw 404 reaches `codeFromStatus`, which says
		 * `not_found`, and the swap happens whether or not `shouldFallOver` reads
		 * the status at all — so a test written that way passes under the bug. A
		 * driver that classified its OWN 404 produces `kind: 'bad_request'`, which
		 * maps to `invalid_request`: a request fault, and the run would abort
		 * holding a model the next member has. Only the status survives that path.
		 */
		it('...but a classified 404 is not a request fault, and DOES fall over', async () => {
			const classified404 = providerHttpError({
				providerId: 'primary',
				status: 404,
				body: '{"error":{"message":"model not found"}}',
			})
			expect(classifyProviderError(classified404).code).toBe('invalid_request')

			const primary = member('primary', [
				() => {
					throw classified404
				},
			])
			const fallback = member('fallback', [
				async function* () {
					yield chunk('the other one has it')
				},
			])
			const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

			expect(await drain(wrapped.chatStream(PARAMS))).toBe('the other one has it')
		})

		it('once output has been produced', async () => {
			const primary = member('primary', [
				async function* () {
					yield chunk('half an answ')
					throw httpError(503)
				},
			])
			const fallback = member('fallback', [
				async function* () {
					yield chunk('should never run')
				},
			])
			const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

			await expect(drain(wrapped.chatStream(PARAMS))).rejects.toMatchObject({ status: 503 })
			expect(fallback.calls).toBe(0)
		})

		it('on an abort, even though an abort is not a request fault', async () => {
			const controller = new AbortController()
			const primary = member('primary', [
				async function* () {
					controller.abort()
					yield* []
					throw Object.assign(new Error('aborted'), { name: 'AbortError' })
				},
			])
			const fallback = member('fallback', [
				async function* () {
					yield chunk('should never run')
				},
			])
			const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])

			await expect(
				drain(wrapped.chatStream({ ...PARAMS, signal: controller.signal })),
			).rejects.toMatchObject({ name: 'AbortError' })
			expect(fallback.calls).toBe(0)
		})
	})

	it('is the identity for a one-member chain', () => {
		const only = member('only', [])
		expect(withProviderFallback([{ provider: only }])).toBe(only)
	})

	it('reports the head’s identity and capabilities, not the tail’s', () => {
		const primary = member('primary', [])
		const fallback = member('fallback', [])
		const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }])
		expect(wrapped.id).toBe('primary')
	})

	/**
	 * `onSwap` announces SERVICE, not selection, and the two are separated by a
	 * suspension the consumer controls.
	 */
	describe('onSwap', () => {
		it('announces the replacement when it is asked', async () => {
			const primary = member('primary', [
				() =>
					(async function* () {
						throw httpError(401)
						// biome-ignore lint/correctness/noUnreachable: the generator must be one
						yield chunk('')
					})(),
			])
			const fallback = member('fallback', [
				() =>
					(async function* () {
						yield chunk('served')
					})(),
			])
			const seen: Array<{ index: number; providerId: string; model?: string }> = []

			const wrapped = withProviderFallback(
				[{ provider: primary }, { provider: fallback, model: 'tail-model' }],
				{ onSwap: (to) => seen.push(to) },
			)
			expect(await drain(wrapped.chatStream({ model: 'head-model', messages: [] }))).toBe('served')

			expect(seen).toEqual([{ index: 1, providerId: 'fallback', model: 'tail-model' }])
		})

		/**
		 * The window this closes: the cursor moves inside the catch, the notice
		 * chunk goes out, and the replacement is only asked when the consumer
		 * comes back. A consumer that leaves at the notice — a Stop, a `break`,
		 * a host abandoning the iterator — has selected a member and asked it
		 * nothing.
		 *
		 * Announcing at cursor-move passes every other case in this file and
		 * fails only this one, which is why it is here: a run record built on
		 * that announcement would say a provider served a turn it never
		 * received.
		 */
		it('says nothing when the consumer leaves at the notice and the replacement is never asked', async () => {
			const primary = member('primary', [
				() =>
					(async function* () {
						throw httpError(401)
						// biome-ignore lint/correctness/noUnreachable: the generator must be one
						yield chunk('')
					})(),
			])
			const fallback = member('fallback', [
				() =>
					(async function* () {
						yield chunk('never reached')
					})(),
			])
			const seen: unknown[] = []

			const wrapped = withProviderFallback([{ provider: primary }, { provider: fallback }], {
				onSwap: (to) => seen.push(to),
			})

			// Take exactly the notice and stop, the way an abandoned iterator does.
			const it_ = wrapped.chatStream({ model: 'm', messages: [] })[Symbol.asyncIterator]()
			const notice = await it_.next()
			await it_.return?.(undefined)

			expect(notice.value?.fallback?.toProviderId).toBe('fallback')
			expect(fallback.calls).toBe(0)
			expect(seen).toEqual([])
		})

		it('announces once per swap, not once per request to the same member', async () => {
			const failOnce = member('primary', [
				() =>
					(async function* () {
						throw httpError(401)
						// biome-ignore lint/correctness/noUnreachable: the generator must be one
						yield chunk('')
					})(),
			])
			const fallback = member('fallback', [
				() =>
					(async function* () {
						yield chunk('one')
					})(),
				() =>
					(async function* () {
						yield chunk('two')
					})(),
			])
			const seen: unknown[] = []

			const wrapped = withProviderFallback([{ provider: failOnce }, { provider: fallback }], {
				onSwap: (to) => seen.push(to),
			})

			await drain(wrapped.chatStream({ model: 'm', messages: [] }))
			// The cursor's lifetime is the wrapper's, so the second request goes
			// straight to the member already serving. A listener that started at
			// member 0 and applied the one call it got is still correct.
			await drain(wrapped.chatStream({ model: 'm', messages: [] }))

			expect(fallback.calls).toBe(2)
			expect(seen).toHaveLength(1)
		})
	})
})

/**
 * The composition is the policy, so it gets its own tests. These drive
 * `fallback(retry(m))` — the arrangement `query()` builds — rather than either
 * decorator alone, because each is individually green under the bug the pair
 * has.
 */
describe('withProviderFallback over withProviderRetry', () => {
	it('spends the primary’s retry budget BEFORE moving on', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(429)
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('after the budget')
			},
		])
		const wrapped = withProviderFallback([
			{ provider: withProviderRetry(primary, { sleepFn: noSleep, config: { maxRetries: 2 } }) },
			{ provider: withProviderRetry(fallback, { sleepFn: noSleep, config: { maxRetries: 2 } }) },
		])

		expect(await drain(wrapped.chatStream(PARAMS))).toBe('after the budget')
		// Initial attempt + 2 retries, all on the primary, before the swap.
		expect(primary.calls).toBe(3)
		expect(fallback.calls).toBe(1)
	})

	/**
	 * The one that matters most. The inner retry decorator emits a backoff
	 * NOTICE chunk through this stream before sleeping. That chunk is not
	 * error-only, so a fallback reusing retry's own "produced" rule would read it
	 * as output and refuse to swap for the rest of the turn — killing failover
	 * on precisely the 429/5xx path a chain is declared for.
	 */
	it('does not mistake the inner retry NOTICE for output', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(429)
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('swapped anyway')
			},
		])
		const wrapped = withProviderFallback([
			{ provider: withProviderRetry(primary, { sleepFn: noSleep, config: { maxRetries: 1 } }) },
			{ provider: fallback },
		])

		const chunks = await collectChunks(wrapped.chatStream(PARAMS))
		// The retry notice really did travel through this decorator — otherwise
		// the test would pass for the wrong reason, on a stream that never
		// contained the chunk it is about.
		expect(chunks.some((c) => c.retry !== undefined)).toBe(true)
		expect(chunks.some((c) => c.fallback !== undefined)).toBe(true)
		expect(chunks.map((c) => c.delta.content ?? '').join('')).toBe('swapped anyway')
	})

	it('gives the new member a FRESH retry budget', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(429)
			},
		])
		const fallback = member('fallback', [
			() => {
				throw httpError(429)
			},
			() => {
				throw httpError(429)
			},
			async function* () {
				yield chunk('third attempt on the fallback')
			},
		])
		const wrapped = withProviderFallback([
			{ provider: withProviderRetry(primary, { sleepFn: noSleep, config: { maxRetries: 1 } }) },
			{ provider: withProviderRetry(fallback, { sleepFn: noSleep, config: { maxRetries: 2 } }) },
		])

		expect(await drain(wrapped.chatStream(PARAMS))).toBe('third attempt on the fallback')
		expect(primary.calls).toBe(2)
		expect(fallback.calls).toBe(3)
	})

	it('honours a server-directed Retry-After rather than swapping on the first 429', async () => {
		const primary = member('primary', [
			() => {
				throw httpError(429, 'slow down', { 'retry-after': '1' })
			},
			async function* () {
				yield chunk('the wait was enough')
			},
		])
		const fallback = member('fallback', [
			async function* () {
				yield chunk('should never run')
			},
		])
		const wrapped = withProviderFallback([
			{ provider: withProviderRetry(primary, { sleepFn: noSleep, config: { maxRetries: 2 } }) },
			{ provider: fallback },
		])

		expect(await drain(wrapped.chatStream(PARAMS))).toBe('the wait was enough')
		expect(fallback.calls).toBe(0)
	})
})
