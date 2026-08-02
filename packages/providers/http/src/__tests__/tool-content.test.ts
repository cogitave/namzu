import { describe, expect, it, vi } from 'vitest'

import { HttpProvider } from '../client.js'

/**
 * Tool messages are text-only on both dialects this driver speaks, so a
 * content-block array has to be flattened. The openai path passed the
 * array through raw (a malformed body) and the anthropic path
 * `JSON.stringify`d it, dumping a screenshot's base64 payload into the
 * prompt as JSON text — unreadable to the model and ruinous in tokens.
 */

const PNG_BYTES = 'iVBORw0KGgoAAAANSUhEUg'

function captureBody(dialect: 'openai' | 'anthropic') {
	const bodies: Record<string, unknown>[] = []
	vi.stubGlobal(
		'fetch',
		vi.fn(async (_url: string, init: { body: string }) => {
			bodies.push(JSON.parse(init.body))
			return {
				ok: true,
				body: null,
				json: async () => ({ choices: [], content: [] }),
			} as never
		}),
	)

	const provider = new HttpProvider({
		baseURL: 'http://localhost:1234/v1',
		dialect,
		model: 'test-model',
	})
	return { provider, bodies }
}

const toolMessages = [
	{ role: 'user' as const, content: 'take a screenshot' },
	{
		role: 'assistant' as const,
		content: null,
		toolCalls: [
			{ id: 'call_1', type: 'function' as const, function: { name: 'shot', arguments: '{}' } },
		],
	},
	{
		role: 'tool' as const,
		toolCallId: 'call_1',
		content: [
			{ type: 'text' as const, text: 'captured' },
			{ type: 'image' as const, data: PNG_BYTES, mediaType: 'image/png' },
		],
	},
]

describe.each(['openai', 'anthropic'] as const)('%s dialect', (dialect) => {
	it('never puts the base64 payload in the request body', async () => {
		const { provider, bodies } = captureBody(dialect)

		try {
			for await (const _ of provider.chatStream({
				model: 'test-model',
				messages: toolMessages as never,
				maxTokens: 64,
			})) {
				// drain
			}
		} catch {
			// The fake response is not a real stream; the body is already captured.
		}

		expect(bodies).toHaveLength(1)
		const serialized = JSON.stringify(bodies[0])
		expect(serialized).not.toContain(PNG_BYTES)
		// The text half survives, and the image is named rather than inlined.
		expect(serialized).toContain('captured')
		expect(serialized).toContain('image/png')
	})
})
