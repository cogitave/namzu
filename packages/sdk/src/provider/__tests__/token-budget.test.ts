import { describe, expect, it } from 'vitest'
import { TokenBudget } from '../../run/token-budget.js'
import type { TokenUsage } from '../../types/common/index.js'
import { ProviderError } from '../../types/provider/errors.js'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import { generateRunId } from '../../utils/id.js'
import { collectChatCompletion } from '../collect-chat-completion.js'
import { withTokenBudget } from '../token-budget.js'

const usage = (tokens: number): TokenUsage => ({
	promptTokens: tokens,
	completionTokens: 0,
	totalTokens: tokens,
	cachedTokens: 0,
	cacheWriteTokens: 0,
})
const params: ChatCompletionParams = { model: 'mock', messages: [] }
function provider(stream: () => AsyncIterable<StreamChunk>): LLMProvider {
	return { id: 'mock', name: 'mock', chatStream: stream }
}

describe('provider calls use the shared token account', () => {
	it('records cancellation before a stalled driver settles and retains its late usage', async () => {
		let lateSaved!: () => void
		const lateReceipt = new Promise<void>((resolve) => {
			lateSaved = resolve
		})
		const budget = TokenBudget.create(1_000, generateRunId(), {
			save: async (snapshot) => {
				if (snapshot.requests[0]?.usage?.totalTokens === 180) lateSaved()
			},
		})
		const caller = new AbortController()
		let enter!: () => void
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let calls = 0
		const wrapped = withTokenBudget(
			provider(async function* () {
				calls++
				yield { id: 'a', delta: { content: 'partial' }, usage: usage(120) }
				enter()
				await held
				yield { id: 'a', delta: {}, usage: usage(180) }
			}),
			budget,
		)
		const iterator = wrapped
			.chatStream({ ...params, signal: caller.signal })
			[Symbol.asyncIterator]()
		await iterator.next()
		const pending = iterator.next()
		await entered
		const reason = new Error('operator stopped')
		caller.abort(reason)
		try {
			await expect(pending).rejects.toBe(reason)
			expect(budget.ownTokens).toBe(120)
			expect(budget.summary()).toMatchObject({ poisoned: true, inFlightRequests: 1 })
			expect(budget.snapshot().requests[0]?.usage?.totalTokens).toBe(120)
			release()
			await lateReceipt
			await budget.flush()
			expect(budget.ownTokens).toBe(180)
			expect(budget.summary()).toMatchObject({ poisoned: true, inFlightRequests: 1 })
			await expect(collectChatCompletion(wrapped.chatStream(params))).rejects.toThrow(
				'no available allowance',
			)
			expect(calls).toBe(1)
		} finally {
			release()
			await pending.catch(() => {})
		}
	})

	it('persists admission before contacting the driver and merges streaming receipts once', async () => {
		let persisted = false
		const budget = TokenBudget.create(1_000, generateRunId(), {
			save: async (snapshot) => {
				if (snapshot.requests.length) persisted = true
			},
		})
		const wrapped = withTokenBudget(
			provider(async function* () {
				expect(persisted).toBe(true)
				yield { id: 'a', delta: {}, usage: usage(200) }
				yield {
					id: 'a',
					delta: { content: 'done' },
					usage: { ...usage(0), completionTokens: 30, totalTokens: 30 },
				}
			}),
			budget,
		)
		await collectChatCompletion(wrapped.chatStream(params))
		expect(budget.ownTokens).toBe(230)
		expect(budget.summary().inFlightRequests).toBe(0)
	})

	it('retains partial measured usage and blocks fresh requests after a broken stream', async () => {
		const budget = TokenBudget.create(1_000, generateRunId())
		let calls = 0
		const wrapped = withTokenBudget(
			provider(async function* () {
				calls++
				yield { id: 'a', delta: { content: 'partial' }, usage: usage(120) }
				throw new Error('connection lost')
			}),
			budget,
		)
		await expect(collectChatCompletion(wrapped.chatStream(params))).rejects.toThrow(
			'connection lost',
		)
		expect(budget.ownTokens).toBe(120)
		expect(budget.summary()).toMatchObject({ poisoned: true, inFlightRequests: 1 })
		await expect(collectChatCompletion(wrapped.chatStream(params))).rejects.toThrow(
			'no available allowance',
		)
		expect(calls).toBe(1)
	})

	it('releases a request rejected before generation without minting spend', async () => {
		const budget = TokenBudget.create(1_000, generateRunId())
		const wrapped = withTokenBudget(
			provider(async function* () {
				yield* []
				throw new ProviderError({ code: 'context_length_exceeded', message: 'too large' })
			}),
			budget,
		)
		await expect(collectChatCompletion(wrapped.chatStream(params))).rejects.toThrow('too large')
		expect(budget.remaining).toBe(1_000)
		expect(budget.summary()).toMatchObject({ poisoned: false, inFlightRequests: 0 })
	})

	it('does not turn a missing usage receipt into a zero-cost successful request', async () => {
		const budget = TokenBudget.create(1_000, generateRunId())
		const wrapped = withTokenBudget(
			provider(async function* () {
				yield { id: 'a', delta: { content: 'answer' }, finishReason: 'stop' }
			}),
			budget,
		)
		await expect(collectChatCompletion(wrapped.chatStream(params))).rejects.toThrow(
			'without token usage',
		)
		expect(budget.remaining).toBe(0)
		expect(budget.summary().inFlightRequests).toBe(1)
	})
})
