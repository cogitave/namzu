import type { ChatCompletionParams } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import { OpenAIProvider } from '../client.js'
import type { OpenAIConfig } from '../types.js'

/**
 * A call for no reasoning must turn reasoning off on a compatible endpoint that
 * has its own switch: `reasoning_effort` alone is ignored by many of them, and
 * reasoning that arrives anyway must not be shown or billed as thought.
 */

function providerOver(
	config: Partial<OpenAIConfig>,
	chunks: readonly Record<string, unknown>[],
): { provider: OpenAIProvider; create: ReturnType<typeof vi.fn> } {
	const provider = new OpenAIProvider({ apiKey: 'test-key', ...config })
	const create = vi.fn(async (_body: Record<string, unknown>) =>
		(async function* () {
			for (const chunk of chunks) yield chunk
		})(),
	)
	;(provider as unknown as { client: { chat: { completions: { create: unknown } } } }).client = {
		chat: { completions: { create } },
	}
	return { provider, create }
}

const finish = {
	id: 'c1',
	choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
	usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
}

async function drain(provider: OpenAIProvider, extra: Partial<ChatCompletionParams>) {
	const out: unknown[] = []
	for await (const chunk of provider.chatStream({
		model: 'some-model',
		messages: [{ role: 'user', content: 'hi' }],
		...extra,
	} as ChatCompletionParams)) {
		out.push(chunk)
	}
	return out as Array<{ delta: { reasoning?: { text?: string } } }>
}

describe('effort none on a compatible endpoint', () => {
	it('sends the endpoint own switch with effort none, and only then', async () => {
		const { provider, create } = providerOver(
			{ thinkingOffFields: { thinking: { type: 'disabled' } } },
			[finish],
		)
		await drain(provider, { effort: 'none' })
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			reasoning_effort: 'none',
			thinking: { type: 'disabled' },
		})
		await drain(provider, { effort: 'high' })
		expect(create.mock.calls[1]?.[0]).not.toHaveProperty('thinking')
		await drain(provider, {})
		expect(create.mock.calls[2]?.[0]).not.toHaveProperty('thinking')
	})

	it('also sends it when thinking is disabled, and asks a function for the model', async () => {
		const { provider, create } = providerOver(
			{
				thinkingOffFields: (model) =>
					model === 'some-model' ? { enable_thinking: false } : undefined,
			},
			[finish],
		)
		await drain(provider, { thinking: { type: 'disabled' } })
		expect(create.mock.calls[0]?.[0]).toMatchObject({ enable_thinking: false })
		await drain(provider, { effort: 'none', model: 'other-model' })
		expect(create.mock.calls[1]?.[0]).not.toHaveProperty('enable_thinking')
	})

	it('sends nothing extra when no fields are configured', async () => {
		const { provider, create } = providerOver({}, [finish])
		await drain(provider, { effort: 'none' })
		expect(Object.keys(create.mock.calls[0]?.[0] ?? {})).not.toContain('thinking')
	})

	it('drops reasoning that arrives although none was asked for', async () => {
		const chunks = [
			{ id: 'c1', choices: [{ index: 0, delta: { reasoning_content: 'pondering' } }] },
			{ id: 'c1', choices: [{ index: 0, delta: { content: 'hello' } }] },
			finish,
		]
		const off = await drain(providerOver({}, chunks).provider, { effort: 'none' })
		expect(off.some((c) => c.delta.reasoning?.text === 'pondering')).toBe(false)
		const on = await drain(providerOver({}, chunks).provider, {})
		expect(on.some((c) => c.delta.reasoning?.text === 'pondering')).toBe(true)
	})
})
