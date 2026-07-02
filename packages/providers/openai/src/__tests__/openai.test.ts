import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import type { ChatCompletionParams } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { toOpenAIMessages } from '../client.js'
import { OPENAI_CAPABILITIES, OpenAIProvider, registerOpenAI } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'openai' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('openai')) {
		ProviderRegistry.unregister('openai')
	}
})

describe('@namzu/openai', () => {
	describe('registerOpenAI()', () => {
		it("adds 'openai' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('openai')).toBe(false)
			registerOpenAI()
			expect(ProviderRegistry.isSupported('openai')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('openai')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerOpenAI()
			expect(() => registerOpenAI()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerOpenAI()
			expect(() => registerOpenAI({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('openai')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerOpenAI()
			const caps = ProviderRegistry.getCapabilities('openai')
			expect(caps).toEqual(OPENAI_CAPABILITIES)
		})
	})

	describe('OPENAI_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(OPENAI_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				supportsVision: true,
			})
		})

		it('is exposed on the provider instance for runtime negotiation', () => {
			const provider = new OpenAIProvider({ apiKey: 'test-key' })
			expect(provider.capabilities).toEqual(OPENAI_CAPABILITIES)
		})
	})

	describe('ProviderRegistry.create({ type: "openai", ... })', () => {
		it('narrows the config type via module augmentation and instantiates OpenAIProvider', () => {
			registerOpenAI()
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'openai',
				apiKey: 'test-key',
				model: 'gpt-4o-mini',
			})
			expect(provider).toBeInstanceOf(OpenAIProvider)
			expect(capabilities).toEqual(OPENAI_CAPABILITIES)
		})

		it('throws when apiKey is missing', () => {
			registerOpenAI()
			expect(() =>
				ProviderRegistry.create({
					type: 'openai',
					apiKey: '',
				}),
			).toThrowError(/API key is required/)
		})
	})

	describe('toOpenAIMessages image attachments', () => {
		it('maps user-message attachments to image_url content parts with base64 data URIs', () => {
			const messages: ChatCompletionParams['messages'] = [
				{
					role: 'user',
					content: 'what is in this image?',
					attachments: [
						{ data: 'aGVsbG8=', mediaType: 'image/png' },
						{ data: 'd29ybGQ=', mediaType: 'image/jpeg' },
					],
				},
			]

			const [mapped] = toOpenAIMessages(messages)
			expect(mapped).toEqual({
				role: 'user',
				content: [
					{ type: 'text', text: 'what is in this image?' },
					{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
					{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,d29ybGQ=' } },
				],
			})
		})

		it('omits the text part when the user message is empty but keeps the images', () => {
			const messages: ChatCompletionParams['messages'] = [
				{
					role: 'user',
					content: '',
					attachments: [{ data: 'aGVsbG8=', mediaType: 'image/webp' }],
				},
			]

			const [mapped] = toOpenAIMessages(messages)
			expect(mapped).toEqual({
				role: 'user',
				content: [{ type: 'image_url', image_url: { url: 'data:image/webp;base64,aGVsbG8=' } }],
			})
		})

		it('keeps plain text-only user messages in string form (no content parts)', () => {
			const messages: ChatCompletionParams['messages'] = [{ role: 'user', content: 'hello' }]
			expect(toOpenAIMessages(messages)).toEqual([{ role: 'user', content: 'hello' }])
		})
	})
})
