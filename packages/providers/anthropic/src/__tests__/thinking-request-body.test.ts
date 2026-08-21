import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * The resolver's own tests pass whether or not the client calls it. These
 * drive the real `chatStream` and read the body that would have gone on the
 * wire, because "declared, typed, exported, and never sent" is precisely the
 * defect being fixed here — `display` had been on `ThinkingConfig` all along
 * and the request builder dropped it.
 */

function providerWithCapturedRequest(
	config: ConstructorParameters<typeof AnthropicProvider>[0] = {
		apiKey: 'test-key',
	},
): {
	readonly provider: AnthropicProvider
	readonly create: ReturnType<typeof vi.fn>
	readonly seen: { body?: Record<string, unknown> }
} {
	const seen: { body?: Record<string, unknown> } = {}
	const provider = new AnthropicProvider(config)
	const create = vi.fn(async (body: Record<string, unknown>) => {
		seen.body = body
		return (async function* () {
			yield { type: 'message_start', message: { id: 'msg_1' } }
		})()
	})
	;(provider as unknown as { client: { messages: { create: unknown } } }).client = {
		messages: { create },
	}
	return { provider, create, seen }
}

async function bodyFor(params: Partial<ChatCompletionParams>): Promise<Record<string, unknown>> {
	const { provider, seen } = providerWithCapturedRequest()
	for await (const _chunk of provider.chatStream({
		model: 'claude-sonnet-5',
		messages: [{ role: 'user', content: 'hi' }],
		...params,
	} as ChatCompletionParams)) {
		// drain
	}
	return seen.body ?? {}
}

describe('the thinking configuration that reaches the wire', () => {
	it('sends adaptive to a model that only accepts adaptive', async () => {
		const body = await bodyFor({
			model: 'claude-sonnet-5',
			thinking: { type: 'adaptive' },
		})

		expect(body.thinking).toEqual({ type: 'adaptive' })
	})

	it('does not send a manual budget to a model that rejects manual mode', async () => {
		// This is the failure being fixed: the old builder passed `enabled`
		// straight through, and the vendor answers that with a 400.
		const body = await bodyFor({
			model: 'claude-sonnet-5',
			thinking: { type: 'enabled', budgetTokens: 10_000 },
		})

		expect(body.thinking).toEqual({ type: 'adaptive' })
		expect(JSON.stringify(body)).not.toContain('budget_tokens')
	})

	it('still sends a manual budget to a manual model', async () => {
		const body = await bodyFor({
			model: 'claude-sonnet-4-5',
			thinking: { type: 'enabled', budgetTokens: 10_000 },
		})

		expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 10_000 })
	})

	it('serializes display, without which the thinking text comes back empty', async () => {
		const body = await bodyFor({
			model: 'claude-sonnet-5',
			thinking: { type: 'adaptive', display: 'summarized' },
		})

		expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' })
	})

	it('sends effort beside thinking, not inside it', async () => {
		const body = await bodyFor({
			model: 'claude-sonnet-5',
			thinking: { type: 'adaptive' },
			effort: 'xhigh',
		})

		expect(body.output_config).toEqual({ effort: 'xhigh' })
		expect(body.thinking).toEqual({ type: 'adaptive' })
	})

	it('sends effort even with no thinking configuration at all', async () => {
		// Effort shapes the whole response, so it is not conditional on a
		// thinking block being present.
		const body = await bodyFor({ model: 'claude-sonnet-5', effort: 'low' })

		expect(body.output_config).toEqual({ effort: 'low' })
	})

	it('refuses effort a model does not accept before transport', async () => {
		const { provider, create } = providerWithCapturedRequest()

		await expect(
			(async () => {
				for await (const _chunk of provider.chatStream({
					model: 'claude-sonnet-4-5',
					messages: [{ role: 'user', content: 'hi' }],
					effort: 'high',
				})) {
					// drain
				}
			})(),
		).rejects.toThrow(/Supported levels: none/)
		expect(create).not.toHaveBeenCalled()
	})

	it('validates against the configured default model when the request model is empty', async () => {
		const { provider, create, seen } = providerWithCapturedRequest({
			apiKey: 'test-key',
			model: 'claude-sonnet-5',
		})

		for await (const _chunk of provider.chatStream({
			model: '',
			messages: [{ role: 'user', content: 'hi' }],
			effort: 'high',
		})) {
			// drain
		}

		expect(create).toHaveBeenCalledTimes(1)
		expect(seen.body).toMatchObject({
			model: 'claude-sonnet-5',
			output_config: { effort: 'high' },
		})
	})

	it('omits thinking entirely on a model that cannot be told to stop', async () => {
		const body = await bodyFor({
			model: 'claude-fable-5',
			thinking: { type: 'disabled' },
		})

		expect(body.thinking).toBeUndefined()
	})

	it('sends no thinking field when the caller configured none', async () => {
		const body = await bodyFor({ model: 'claude-sonnet-5' })

		expect(body.thinking).toBeUndefined()
		expect(body.output_config).toBeUndefined()
	})
})
