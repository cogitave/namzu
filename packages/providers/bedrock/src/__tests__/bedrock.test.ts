import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { toBedrockMessages } from '../client.js'
import { BEDROCK_CAPABILITIES, BedrockProvider, registerBedrock } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'bedrock' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('bedrock')) {
		ProviderRegistry.unregister('bedrock')
	}
})

describe('@namzu/bedrock', () => {
	describe('registerBedrock()', () => {
		it("adds 'bedrock' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('bedrock')).toBe(false)
			registerBedrock()
			expect(ProviderRegistry.isSupported('bedrock')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('bedrock')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerBedrock()
			expect(() => registerBedrock()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerBedrock()
			expect(() => registerBedrock({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('bedrock')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerBedrock()
			const caps = ProviderRegistry.getCapabilities('bedrock')
			expect(caps).toEqual(BEDROCK_CAPABILITIES)
		})
	})

	describe('BEDROCK_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(BEDROCK_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				supportsVision: false,
			})
		})

		it('is exposed on the provider instance for runtime negotiation', () => {
			const provider = new BedrockProvider({ region: 'us-east-1' })
			expect(provider.capabilities).toEqual(BEDROCK_CAPABILITIES)
		})
	})
})

describe('Converse tool results carry failure status', () => {
	it('marks a failed tool result with status: error', () => {
		// The executor computed `isError`, the SSE and A2A bridges carried
		// it, and then this driver flattened every failure into an ordinary
		// success. Converse has a first-class field for it; the model's
		// trained tool-failure recovery path keys off that field.
		const mapped = toBedrockMessages([
			{ role: 'assistant', content: null, toolCalls: [] },
			{ role: 'tool', content: 'Error: file not found', toolCallId: 'call_1', isError: true },
		] as never)

		const block = mapped.flatMap((m) => m.content ?? []).find((c) => 'toolResult' in c)
		expect(block).toBeDefined()
		expect((block as { toolResult: { status?: string } }).toolResult.status).toBe('error')
	})

	it('leaves a successful tool result unmarked', () => {
		const mapped = toBedrockMessages([
			{ role: 'assistant', content: null, toolCalls: [] },
			{ role: 'tool', content: 'ok', toolCallId: 'call_1' },
		] as never)

		const block = mapped.flatMap((m) => m.content ?? []).find((c) => 'toolResult' in c)
		expect((block as { toolResult: { status?: string } }).toolResult.status).toBeUndefined()
	})
})
