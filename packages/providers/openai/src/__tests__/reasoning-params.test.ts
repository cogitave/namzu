import type { ChatCompletionParams, ReasoningEffort } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
	OPENAI_CAPABILITIES,
	OpenAIProvider,
	assertThinkingSupported,
	openAIReasoningEffortLevels,
} from '../client.js'

/**
 * This driver does not implement extended thinking, and used to accept the
 * request anyway.
 *
 * So a caller who asked for reasoning got an ordinary completion: no
 * thinking, no reasoning blocks, and no error. The empty reasoning list
 * that came back reads as "the model did not reason" rather than "nobody
 * asked it to" — which is the failure mode, not the missing feature. Same
 * call as the citations one in this driver: refuse what cannot be
 * delivered rather than deliver something else quietly.
 */

describe('a thinking request is refused, not dropped', () => {
	it('refuses adaptive for the same reason it refuses manual', () => {
		// Both are a request to think, and this driver would answer either
		// with an ordinary completion and an empty reasoning list.
		expect(() => assertThinkingSupported({ thinking: { type: 'adaptive' } })).toThrow(
			/does not implement thinking/i,
		)
	})

	it('throws when thinking is asked for', () => {
		// Names the driver, which is what turns a bug report about the model
		// into a one-line configuration fix in a multi-provider setup.
		expect(() => assertThinkingSupported({ thinking: { type: 'enabled' } })).toThrow(
			/OpenAIProvider does not implement thinking/i,
		)
	})

	it('says what to do instead', () => {
		expect(() => assertThinkingSupported({ thinking: { type: 'enabled' } })).toThrow(
			/Drop `thinking`/,
		)
	})

	it('explains why silence would be worse than an error', () => {
		// The message has to name the symptom the caller would otherwise
		// see, or they will read the empty list as an answer.
		expect(() => assertThinkingSupported({ thinking: { type: 'enabled' } })).toThrow(
			/empty reasoning list/,
		)
	})
})

describe('asking for it to be off is honoured as a no-op', () => {
	it('accepts an explicit disable', () => {
		// Off is the state this driver is already in, so refusing here would
		// reject a request it is in fact satisfying.
		expect(() => assertThinkingSupported({ thinking: { type: 'disabled' } })).not.toThrow()
	})

	it('accepts a call that says nothing about thinking', () => {
		expect(() => assertThinkingSupported({})).not.toThrow()
	})
})

function providerWithCapturedRequest(): {
	readonly provider: OpenAIProvider
	readonly create: ReturnType<typeof vi.fn>
} {
	const provider = new OpenAIProvider({ apiKey: 'test-key' })
	const create = vi.fn(async (_body: Record<string, unknown>) =>
		(async function* () {
			yield {
				id: 'msg_done',
				choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
				usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
			}
		})(),
	)
	;(provider as unknown as { client: unknown }).client = {
		chat: { completions: { create } },
	}
	return { provider, create }
}

async function send(
	provider: OpenAIProvider,
	params: Pick<ChatCompletionParams, 'model' | 'effort' | 'thinking'>,
): Promise<void> {
	for await (const _chunk of provider.chatStream({
		...params,
		messages: [{ role: 'user', content: 'reason about this' }],
	})) {
		// Drain the provider stream so the captured body is the production call.
	}
}

describe('reasoning effort reaches the Chat Completions wire', () => {
	const accepted = [
		['gpt-5.2', 'none'],
		['gpt-5', 'minimal'],
		['gpt-5.2', 'low'],
		['gpt-5.2', 'medium'],
		['gpt-5.2', 'high'],
		['gpt-5.2', 'xhigh'],
		['gpt-5.6-sol', 'max'],
		['gateway/future-model', 'ultra'],
	] as const satisfies readonly (readonly [string, ReasoningEffort])[]

	it.each(accepted)('maps %s effort %s exactly', async (model, effort) => {
		const { provider, create } = providerWithCapturedRequest()

		await send(provider, { model, effort })

		expect(create).toHaveBeenCalledTimes(1)
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			model,
			reasoning_effort: effort,
		})
	})

	it('omits the wire key entirely when nobody selected an effort', async () => {
		const { provider, create } = providerWithCapturedRequest()

		await send(provider, { model: 'gpt-5.2' })

		expect(create).toHaveBeenCalledTimes(1)
		expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning_effort')
	})
})

describe('recognized models refuse levels their published set does not contain', () => {
	const refused = [
		['gpt-5.2', 'minimal'],
		['gpt-5.2', 'max'],
		['gpt-5.2', 'ultra'],
		['gpt-5', 'none'],
		['gpt-5', 'xhigh'],
		['gpt-5.6-sol', 'minimal'],
		['gpt-5.6-sol', 'ultra'],
	] as const satisfies readonly (readonly [string, ReasoningEffort])[]

	it.each(refused)('refuses %s effort %s before transport', async (model, effort) => {
		const { provider, create } = providerWithCapturedRequest()

		await expect(send(provider, { model, effort })).rejects.toThrow(
			new RegExp(`effort "${effort}" is not supported by model "${model}"`),
		)
		expect(create).not.toHaveBeenCalled()
	})

	it('still refuses unsupported extended thinking before an otherwise valid effort request', async () => {
		const { provider, create } = providerWithCapturedRequest()

		await expect(
			send(provider, {
				model: 'gpt-5.2',
				effort: 'high',
				thinking: { type: 'adaptive' },
			}),
		).rejects.toThrow(/does not implement thinking/i)
		expect(create).not.toHaveBeenCalled()
	})
})

describe('published model effort sets are exact and unknown stays unknown', () => {
	it('publishes the same answer through the provider capability contract', () => {
		const provider = new OpenAIProvider({ apiKey: 'test-key' })

		expect(provider.reasoningEffortLevelsFor('gpt-5.2')).toEqual([
			'none',
			'low',
			'medium',
			'high',
			'xhigh',
		])
		expect(provider.reasoningEffortLevelsFor('gateway/future-model')).toBeUndefined()
	})

	it('distinguishes the model generations and their snapshots', () => {
		expect(openAIReasoningEffortLevels('gpt-5-2025-08-07')).toEqual([
			'minimal',
			'low',
			'medium',
			'high',
		])
		expect(openAIReasoningEffortLevels('gpt-5.1-2025-11-13')).toEqual([
			'none',
			'low',
			'medium',
			'high',
		])
		expect(openAIReasoningEffortLevels('gpt-5.2')).toEqual([
			'none',
			'low',
			'medium',
			'high',
			'xhigh',
		])
		expect(openAIReasoningEffortLevels('gpt-5.6-terra')).toEqual([
			'none',
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
		])
	})

	it('does not turn an unknown compatible-endpoint model into a false empty set', () => {
		expect(openAIReasoningEffortLevels('gateway/future-model')).toBeUndefined()
	})
})

describe('the declared capabilities stay honest', () => {
	it('claims the tools and streaming it does implement', () => {
		expect(OPENAI_CAPABILITIES.supportsTools).toBe(true)
		expect(OPENAI_CAPABILITIES.supportsStreaming).toBe(true)
		expect(OPENAI_CAPABILITIES.supportsFunctionCalling).toBe(true)
	})

	it('claims the vision and documents it now maps', () => {
		expect(OPENAI_CAPABILITIES.supportsVision).toBe(true)
		expect(OPENAI_CAPABILITIES.supportsDocuments).toBe(true)
	})

	it('answers every flag the negotiation reads', () => {
		// An absent flag defaults to permissive, so a missing one is not a
		// neutral omission — it is a claim.
		for (const flag of [
			'supportsTools',
			'supportsStreaming',
			'supportsFunctionCalling',
			'supportsVision',
			'supportsDocuments',
		] as const) {
			expect(typeof OPENAI_CAPABILITIES[flag]).toBe('boolean')
		}
	})
})
