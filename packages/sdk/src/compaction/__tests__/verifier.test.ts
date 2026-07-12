// Current-code invariants asserted (2026-07-12, ses_015 fix-batch):
// - buildVerifiedSummary routes its provider.chat through chatWithRetry, so a
//   transient throttle/server/network blip is retried rather than failing the
//   whole compaction pass (the provider adapters no longer retry internally).
//   A single 503 on the first attempt recovers on the second.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompactionConfigSchema } from '../../config/runtime.js'
import { ProviderRequestError } from '../../provider/errors.js'
import { createUserMessage } from '../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../types/provider/index.js'
import { WorkingStateManager } from '../manager.js'
import { serializeState } from '../serializer.js'
import { buildVerifiedSummary } from '../verifier.js'

/**
 * Fire retry-backoff timeouts immediately so the test does not sleep.
 *
 * Skips the long ones. `attemptModelCall` also arms a timer per attempt for the
 * call's own deadline (pre-freeze B2), carrying the whole remaining budget —
 * firing THAT synchronously would abandon every call before the provider could
 * answer. Backoff waits are bounded by `maxDelayMs` (30s), the ancillary call
 * budget is 120s, so 60s separates them cleanly.
 */
function instantTimers(): () => void {
	const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
		cb: () => void,
		ms?: number,
	) => {
		if ((ms ?? 0) < 60_000) cb()
		return 0 as unknown as ReturnType<typeof setTimeout>
	}) as typeof setTimeout)
	return () => spy.mockRestore()
}

interface CountingProvider extends LLMProvider {
	calls: number
}

function completeAfterOneFailure(): CountingProvider {
	const provider: CountingProvider = {
		id: 'fake',
		name: 'Fake',
		calls: 0,
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			provider.calls += 1
			if (provider.calls === 1) {
				throw new ProviderRequestError('overloaded', { kind: 'server', providerId: 'fake' })
			}
			return {
				id: 'verify_1',
				model: 'm',
				message: { role: 'assistant', content: 'COMPLETE' },
				finishReason: 'stop',
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
	return provider
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('buildVerifiedSummary — retry coverage', () => {
	it('retries a transient 503 once and returns the verified summary', async () => {
		const restore = instantTimers()
		const config = CompactionConfigSchema.parse({})
		const manager = new WorkingStateManager(config)
		manager.setTask('the ongoing task tracked in working state')

		const provider = completeAfterOneFailure()
		const olderMessages = [createUserMessage('older conversation content to summarise here')]

		const summary = await buildVerifiedSummary(manager, olderMessages, provider, config)
		restore()

		// The first attempt threw 503; the second succeeded — two physical calls.
		expect(provider.calls).toBe(2)
		// Response 'COMPLETE' means the serialized state is returned unchanged.
		expect(summary).toBe(serializeState(manager.getState()))
	})
})
