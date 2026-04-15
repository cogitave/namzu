import { beforeEach, describe, expect, it } from 'vitest'
import type { LLMProvider, ProviderCapabilities } from '../../types/provider/index.js'
import { registerMock } from '../mock-register.js'
import { MockLLMProvider } from '../mock.js'
import {
	DuplicateProviderError,
	ProviderRegistry,
	UnknownProviderError,
	__resetProviderRegistryInternal,
} from '../registry.js'

// Simulate a downstream provider package's type registration via module augmentation.
// This is the pattern @namzu/bedrock, @namzu/openai, etc. use in their own code.
interface TestProviderConfig {
	type: 'test'
	value?: string
}

declare module '../../types/provider/config.js' {
	interface ProviderConfigRegistry {
		test: TestProviderConfig
	}
}

class TestProvider implements LLMProvider {
	readonly id = 'test'
	readonly name = 'Test'
	constructor(public readonly config: TestProviderConfig) {}
	async chat() {
		return {
			id: 'x',
			model: 'm',
			message: { role: 'assistant' as const, content: 'ok' },
			finishReason: 'stop' as const,
			usage: {
				promptTokens: 0,
				completionTokens: 0,
				totalTokens: 0,
				cachedTokens: 0,
				cacheWriteTokens: 0,
			},
		}
	}
	async *chatStream() {
		yield { id: 'x', delta: { content: 'ok' } }
	}
}

const TEST_CAPS: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: true,
	supportsFunctionCalling: false,
}

describe('ProviderRegistry', () => {
	beforeEach(() => {
		__resetProviderRegistryInternal()
		registerMock()
	})

	describe('register', () => {
		it('registers a provider and stores capabilities', () => {
			ProviderRegistry.register('test', TestProvider, {
				supportsTools: true,
				supportsStreaming: false,
				supportsFunctionCalling: true,
			})

			expect(ProviderRegistry.isSupported('test')).toBe(true)
			expect(ProviderRegistry.getCapabilities('test').supportsTools).toBe(true)
		})

		it('throws DuplicateProviderError on re-register without replace', () => {
			ProviderRegistry.register('test', TestProvider, TEST_CAPS)
			expect(() => ProviderRegistry.register('test', TestProvider, TEST_CAPS)).toThrowError(
				DuplicateProviderError,
			)
		})

		it('allows replacement when { replace: true }', () => {
			ProviderRegistry.register('test', TestProvider, TEST_CAPS)
			const newCaps: ProviderCapabilities = {
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			}
			expect(() =>
				ProviderRegistry.register('test', TestProvider, newCaps, { replace: true }),
			).not.toThrow()
			expect(ProviderRegistry.getCapabilities('test').supportsTools).toBe(true)
		})
	})

	describe('create', () => {
		it('instantiates the registered provider with typed config', () => {
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'mock',
				model: 'test-model',
			})
			expect(provider).toBeInstanceOf(MockLLMProvider)
			expect(capabilities.supportsStreaming).toBe(true)
		})

		it('throws UnknownProviderError for unregistered type', () => {
			expect(() =>
				ProviderRegistry.create({ type: 'nonexistent' } as unknown as { type: 'mock' }),
			).toThrowError(UnknownProviderError)
		})
	})

	describe('isSupported', () => {
		it('returns true for registered types', () => {
			expect(ProviderRegistry.isSupported('mock')).toBe(true)
		})

		it('returns false for unregistered types', () => {
			expect(ProviderRegistry.isSupported('nope')).toBe(false)
		})
	})

	describe('unregister', () => {
		it('removes provider and capabilities', () => {
			ProviderRegistry.register('test', TestProvider, TEST_CAPS)
			expect(ProviderRegistry.unregister('test')).toBe(true)
			expect(ProviderRegistry.isSupported('test')).toBe(false)
		})

		it('returns false when type is not registered', () => {
			expect(ProviderRegistry.unregister('test')).toBe(false)
		})
	})

	describe('listTypes', () => {
		it('returns all registered types', () => {
			ProviderRegistry.register('test', TestProvider, TEST_CAPS)
			const types = ProviderRegistry.listTypes()
			expect(types).toContain('mock')
			expect(types).toContain('test')
		})
	})

	describe('error types', () => {
		it('UnknownProviderError preserves type', () => {
			const err = new UnknownProviderError('foo')
			expect(err.providerType).toBe('foo')
			expect(err.name).toBe('UnknownProviderError')
		})

		it('DuplicateProviderError preserves type', () => {
			const err = new DuplicateProviderError('bar')
			expect(err.providerType).toBe('bar')
			expect(err.name).toBe('DuplicateProviderError')
		})
	})
})
