import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { OPENROUTER_CAPABILITIES, OpenRouterProvider, registerOpenRouter } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'openrouter' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('openrouter')) {
		ProviderRegistry.unregister('openrouter')
	}
})

describe('@namzu/openrouter', () => {
	describe('registerOpenRouter()', () => {
		it("adds 'openrouter' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('openrouter')).toBe(false)
			registerOpenRouter()
			expect(ProviderRegistry.isSupported('openrouter')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('openrouter')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerOpenRouter()
			expect(() => registerOpenRouter()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerOpenRouter()
			expect(() => registerOpenRouter({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('openrouter')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerOpenRouter()
			const caps = ProviderRegistry.getCapabilities('openrouter')
			expect(caps).toEqual(OPENROUTER_CAPABILITIES)
		})
	})

	describe('OPENROUTER_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(OPENROUTER_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				supportsVision: true,
				// Images only: a document degrades to a named placeholder here.
				supportsDocuments: false,
			})
		})

		it('is exposed on the provider instance for runtime negotiation', () => {
			const provider = new OpenRouterProvider({ apiKey: 'test-key' })
			expect(provider.capabilities).toEqual(OPENROUTER_CAPABILITIES)
		})
	})

	describe('ProviderRegistry.create({ type: "openrouter", ... })', () => {
		it('narrows the config type via module augmentation and instantiates OpenRouterProvider', () => {
			registerOpenRouter()
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'openrouter',
				apiKey: 'test-key',
				siteUrl: 'https://example.com',
				siteName: 'Test',
			})
			expect(provider).toBeInstanceOf(OpenRouterProvider)
			expect(capabilities).toEqual(OPENROUTER_CAPABILITIES)
		})
	})

	it('keeps the Namzu enforcement hint out of the OpenRouter request body', () => {
		const provider = new OpenRouterProvider({ apiKey: 'test-key' })
		const tools = [
			{
				type: 'function' as const,
				function: {
					name: 'edit',
					description: 'Edit',
					parameters: { type: 'object' },
				},
			},
		]
		const body = (
			provider as unknown as {
				buildRequestBody(
					params: import('@namzu/sdk').ChatCompletionParams,
					stream: boolean,
				): Record<string, unknown>
			}
		).buildRequestBody(
			{
				model: 'anthropic/claude-sonnet-5',
				messages: [{ role: 'user', content: 'edit' }],
				tools,
				enforceToolInputSchema: ['edit'],
			},
			true,
		)

		expect(body).not.toHaveProperty('enforceToolInputSchema')
		expect(body.tools).toEqual(tools)
	})
})
