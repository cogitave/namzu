import { describe, expect, it, vi } from 'vitest'

import type { CompactionConfig } from '../../config/runtime.js'
import { MockLLMProvider } from '../../provider/mock.js'
import type { Message } from '../../types/message/index.js'
import { WorkingStateManager } from '../manager.js'
import { buildVerifiedSummary } from '../verifier.js'

/**
 * The compaction verifier called `provider.chatStream({ model: '' })`.
 *
 * Some drivers quietly substitute a default and others reject outright —
 * on Bedrock the model id IS the endpoint, and OpenRouter requires it. So
 * the verifier failed exactly on the providers where a long run most needs
 * compaction, and the failure surfaced as compaction killing the run it
 * exists to save.
 */

function config(overrides: Partial<CompactionConfig> = {}): CompactionConfig {
	return {
		strategy: 'structured',
		triggerThreshold: 0.7,
		resetThreshold: 0.4,
		keepRecentMessages: 4,
		clearToolResults: true,
		keepRecentToolResults: 3,
		minToolResultCharsToClear: 1_000,
		maxToolResults: 30,
		maxListSize: 25,
		keepFirstEntries: 3,
		llmVerification: true,
		llmVerificationMaxTokens: 2048,
		richStateThreshold: 15,
		convoTextBudget: 12_000,
		maxSentencesPerTurn: 5,
		maxCharsPerNote: 500,
		maxCharsPerRequirement: 300,
		maxCharsPerTask: 400,
		...overrides,
	} as CompactionConfig
}

const older: Message[] = [
	{ role: 'user', content: 'build the thing' },
	{ role: 'assistant', content: 'I built it' } as Message,
]

describe('buildVerifiedSummary', () => {
	it('sends the run`s model, not an empty string', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
		const manager = new WorkingStateManager(config())

		await buildVerifiedSummary(
			manager,
			older,
			provider,
			config(),
			undefined,
			'anthropic.claude-opus-4-v1',
		)

		expect(provider.requests).toHaveLength(1)
		expect(provider.requests[0]?.model).toBe('anthropic.claude-opus-4-v1')
	})

	it('bills the side-channel call to the run', async () => {
		// A compaction pass is not free, and a run that cannot see the cost
		// cannot enforce its own budget.
		const provider = new MockLLMProvider({ turns: [{ text: 'COMPLETE' }] })
		const onUsage = vi.fn()

		await buildVerifiedSummary(
			new WorkingStateManager(config()),
			older,
			provider,
			config(),
			onUsage,
			'some-model',
		)

		expect(onUsage).toHaveBeenCalledOnce()
	})
})
