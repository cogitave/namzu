import type { ChatCompletionParams } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPENROUTER_CAPABILITIES, OpenRouterProvider } from '../client.js'

/**
 * The driver maps user-message images onto the wire, and says which models
 * read them.
 *
 * The runtime reads the flags and `supportsImageInputFor` before the request is
 * built, so they are the contract: a flag claiming the mapping without it makes
 * images vanish silently, and a mapping without the flag makes the runtime
 * replace images the model could have read with an omission marker.
 */

describe('the declared capabilities are the honest ones', () => {
	it('claims vision, because pasted images are mapped', () => {
		expect(OPENROUTER_CAPABILITIES.supportsVision).toBe(true)
	})
	it('does not claim documents', () => {
		expect(OPENROUTER_CAPABILITIES.supportsDocuments).toBe(false)
	})

	it('claims the tool support it does have', () => {
		expect(OPENROUTER_CAPABILITIES.supportsTools).toBe(true)
		expect(OPENROUTER_CAPABILITIES.supportsFunctionCalling).toBe(true)
	})

	it('claims streaming', () => {
		expect(OPENROUTER_CAPABILITIES.supportsStreaming).toBe(true)
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
			expect(typeof OPENROUTER_CAPABILITIES[flag]).toBe('boolean')
		}
	})
})

function provider(): OpenRouterProvider {
	return new OpenRouterProvider({ apiKey: 'k', baseUrl: 'https://example.test/api/v1' })
}

function wireFor(
	messages: ChatCompletionParams['messages'],
): Array<{ role: string; content: unknown }> {
	return (
		provider() as unknown as {
			buildRequestBody(
				p: ChatCompletionParams,
				stream: boolean,
			): { messages: Array<{ role: string; content: unknown }> }
		}
	).buildRequestBody({ model: 'anthropic/claude-haiku-5.5', messages }, true).messages
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('a pasted image reaches the wire', () => {
	it('sends the text and an image_url data URL as content parts', () => {
		const wire = wireFor([
			{
				role: 'user',
				content: 'What does this show?',
				attachments: [{ type: 'image', data: 'QUJD', mediaType: 'image/png' }],
			},
		])
		expect(wire[0]).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'What does this show?' },
				{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
			],
		})
	})

	it('leaves out an image the runtime withheld, and keeps plain text plain', () => {
		const wire = wireFor([
			{
				role: 'user',
				content: 'hi [image omitted]',
				attachments: [
					{
						type: 'image',
						data: 'QUJD',
						mediaType: 'image/png',
						modelOmission: { reason: 'provider-rejected' },
					} as never,
				],
			},
			{ role: 'user', content: 'plain' },
		])
		expect(wire[0]?.content).toBe('hi [image omitted]')
		expect(wire[1]?.content).toBe('plain')
	})
})

describe('which models read images comes from the listing', () => {
	it('answers per model from architecture.input_modalities', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn().mockResolvedValue({
				ok: true,
				status: 200,
				json: async () => ({
					data: [
						{
							id: 'a/vision',
							name: 'v',
							context_length: 1000,
							architecture: { input_modalities: ['text', 'image'] },
						},
						{
							id: 'a/text',
							name: 't',
							context_length: 1000,
							architecture: { input_modalities: ['text'] },
						},
						{ id: 'a/unsaid', name: 'u', context_length: 1000 },
					],
				}),
			}),
		)
		const p = provider()
		// Before any listing was read the answer is "send them".
		expect(p.supportsImageInputFor('a/text')).toBe(true)
		const models = await p.listModels()
		expect(models.find((m) => m.id === 'a/vision')?.inputModalities).toEqual(['text', 'image'])
		expect(models.find((m) => m.id === 'a/unsaid')?.inputModalities).toBeUndefined()
		expect(p.supportsImageInputFor('a/vision')).toBe(true)
		expect(p.supportsImageInputFor('a/text')).toBe(false)
		expect(p.supportsImageInputFor('a/text:nitro')).toBe(false)
		expect(p.supportsImageInputFor('a/unsaid')).toBe(true)
		expect(p.supportsImageInputFor('a/not-listed')).toBe(true)
	})
})
