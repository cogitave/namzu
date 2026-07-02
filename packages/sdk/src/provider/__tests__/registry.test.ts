import { beforeEach, describe, expect, it } from 'vitest'
import type {
	LLMProvider,
	LazyProviderModule,
	ProviderCapabilities,
} from '../../types/provider/index.js'
import { PERMISSIVE_PROVIDER_CAPABILITIES, resolveProviderCapabilities } from '../capabilities.js'
import { registerMock } from '../mock-register.js'
import { MockLLMProvider } from '../mock.js'
import {
	DuplicateProviderError,
	LazyProviderLoadError,
	LazyProviderSyncCreateError,
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

interface LazyTestProviderConfig {
	type: 'lazytest'
	value?: string
}

declare module '../../types/provider/config.js' {
	interface ProviderConfigRegistry {
		test: TestProviderConfig
		lazytest: LazyTestProviderConfig
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

class LazyTestProvider implements LLMProvider {
	readonly id = 'lazytest'
	readonly name = 'Lazy Test'
	constructor(
		public readonly config: LazyTestProviderConfig,
		readonly capabilities?: ProviderCapabilities,
	) {}
	async *chatStream() {
		yield { id: 'x', delta: { content: 'ok' } }
	}
}

const HINT_CAPS: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsFunctionCalling: false,
}

const MODULE_CAPS: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: false,
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
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

	describe('registerLazy', () => {
		it('does not invoke the loader at registration time', () => {
			let calls = 0
			ProviderRegistry.registerLazy('lazytest', async () => {
				calls++
				return { create: (config) => new LazyTestProvider(config) }
			})

			expect(calls).toBe(0)
			expect(ProviderRegistry.isSupported('lazytest')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('lazytest')
		})

		it('throws DuplicateProviderError over an existing eager registration', () => {
			ProviderRegistry.register('test', TestProvider, TEST_CAPS)
			expect(() =>
				ProviderRegistry.registerLazy('test', async () => ({
					create: (config) => new TestProvider(config),
				})),
			).toThrowError(DuplicateProviderError)
		})

		it('throws DuplicateProviderError over an existing lazy registration', () => {
			const loader = async (): Promise<LazyProviderModule<LazyTestProviderConfig>> => ({
				create: (config) => new LazyTestProvider(config),
			})
			ProviderRegistry.registerLazy('lazytest', loader)
			expect(() => ProviderRegistry.registerLazy('lazytest', loader)).toThrowError(
				DuplicateProviderError,
			)
		})

		it('replace: true swaps between eager and lazy registrations', async () => {
			ProviderRegistry.register('lazytest', LazyTestProvider, TEST_CAPS)
			ProviderRegistry.registerLazy(
				'lazytest',
				async () => ({ create: (config) => new LazyTestProvider(config) }),
				{ replace: true },
			)
			expect(() => ProviderRegistry.createProvider({ type: 'lazytest' })).toThrowError(
				LazyProviderSyncCreateError,
			)

			ProviderRegistry.register('lazytest', LazyTestProvider, TEST_CAPS, { replace: true })
			expect(ProviderRegistry.createProvider({ type: 'lazytest' })).toBeInstanceOf(LazyTestProvider)
		})

		it('sync create()/createProvider() always throws for lazy types, even after load', async () => {
			ProviderRegistry.registerLazy('lazytest', async () => ({
				create: (config) => new LazyTestProvider(config),
			}))

			expect(() => ProviderRegistry.create({ type: 'lazytest' })).toThrowError(
				LazyProviderSyncCreateError,
			)

			await ProviderRegistry.createAsync({ type: 'lazytest' })
			expect(() => ProviderRegistry.createProvider({ type: 'lazytest' })).toThrowError(
				LazyProviderSyncCreateError,
			)
		})

		it('unregister removes a lazy registration', () => {
			ProviderRegistry.registerLazy('lazytest', async () => ({
				create: (config) => new LazyTestProvider(config),
			}))
			expect(ProviderRegistry.unregister('lazytest')).toBe(true)
			expect(ProviderRegistry.isSupported('lazytest')).toBe(false)
		})
	})

	describe('createAsync', () => {
		it('first create invokes the loader once; subsequent creates reuse the cached factory', async () => {
			let calls = 0
			ProviderRegistry.registerLazy('lazytest', async () => {
				calls++
				return { create: (config) => new LazyTestProvider(config) }
			})

			const first = await ProviderRegistry.createAsync({ type: 'lazytest', value: 'a' })
			const second = await ProviderRegistry.createAsync({ type: 'lazytest', value: 'b' })

			expect(calls).toBe(1)
			expect(first.provider).toBeInstanceOf(LazyTestProvider)
			expect(second.provider).toBeInstanceOf(LazyTestProvider)
			expect((second.provider as LazyTestProvider).config.value).toBe('b')
		})

		it('concurrent first-creates share a single loader invocation', async () => {
			let calls = 0
			const gate = deferred<void>()
			ProviderRegistry.registerLazy('lazytest', async () => {
				calls++
				await gate.promise
				return { create: (config) => new LazyTestProvider(config) }
			})

			const a = ProviderRegistry.createAsync({ type: 'lazytest' })
			const b = ProviderRegistry.createAsync({ type: 'lazytest' })
			gate.resolve()

			const [ra, rb] = await Promise.all([a, b])
			expect(calls).toBe(1)
			expect(ra.provider).toBeInstanceOf(LazyTestProvider)
			expect(rb.provider).toBeInstanceOf(LazyTestProvider)
		})

		it('loader rejection surfaces as LazyProviderLoadError and the next create retries', async () => {
			let calls = 0
			ProviderRegistry.registerLazy('lazytest', async () => {
				calls++
				if (calls === 1) {
					throw new Error('transient network failure')
				}
				return { create: (config) => new LazyTestProvider(config) }
			})

			const failure = await ProviderRegistry.createAsync({ type: 'lazytest' }).catch(
				(err: unknown) => err,
			)
			expect(failure).toBeInstanceOf(LazyProviderLoadError)
			expect((failure as LazyProviderLoadError).providerType).toBe('lazytest')
			expect(((failure as LazyProviderLoadError).cause as Error).message).toBe(
				'transient network failure',
			)

			const { provider } = await ProviderRegistry.createAsync({ type: 'lazytest' })
			expect(calls).toBe(2)
			expect(provider).toBeInstanceOf(LazyTestProvider)
		})

		it('rejects with LazyProviderLoadError when the loader resolves an invalid module shape', async () => {
			ProviderRegistry.registerLazy(
				'lazytest',
				async () => ({}) as unknown as LazyProviderModule<LazyTestProviderConfig>,
			)
			await expect(ProviderRegistry.createAsync({ type: 'lazytest' })).rejects.toThrowError(
				LazyProviderLoadError,
			)
		})

		it('works for eagerly registered types too', async () => {
			const { provider, capabilities } = await ProviderRegistry.createAsync({
				type: 'mock',
				model: 'test-model',
			})
			expect(provider).toBeInstanceOf(MockLLMProvider)
			expect(capabilities.supportsStreaming).toBe(true)
		})

		it('rejects with UnknownProviderError for unregistered types', async () => {
			await expect(
				ProviderRegistry.createAsync({ type: 'nonexistent' } as unknown as { type: 'mock' }),
			).rejects.toThrowError(UnknownProviderError)
		})
	})

	describe('lazy capabilities', () => {
		it('answers with the registration hint before load, without invoking the loader', () => {
			let calls = 0
			ProviderRegistry.registerLazy(
				'lazytest',
				async () => {
					calls++
					return { create: (config) => new LazyTestProvider(config) }
				},
				{ capabilities: HINT_CAPS },
			)

			expect(ProviderRegistry.getCapabilities('lazytest')).toEqual(HINT_CAPS)
			expect(calls).toBe(0)
		})

		it('answers permissively before load when no hint was given', () => {
			ProviderRegistry.registerLazy('lazytest', async () => ({
				create: (config) => new LazyTestProvider(config),
			}))
			expect(ProviderRegistry.getCapabilities('lazytest')).toEqual(PERMISSIVE_PROVIDER_CAPABILITIES)
		})

		it('module capabilities replace the hint after load', async () => {
			ProviderRegistry.registerLazy(
				'lazytest',
				async () => ({
					create: (config) => new LazyTestProvider(config),
					capabilities: MODULE_CAPS,
				}),
				{ capabilities: HINT_CAPS },
			)

			const { capabilities } = await ProviderRegistry.createAsync({ type: 'lazytest' })
			expect(capabilities).toEqual(MODULE_CAPS)
			expect(ProviderRegistry.getCapabilities('lazytest')).toEqual(MODULE_CAPS)
		})

		it('the constructed instance own capabilities win at run time over any hint', async () => {
			const instanceCaps: ProviderCapabilities = {
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: false,
				supportsVision: false,
			}
			ProviderRegistry.registerLazy(
				'lazytest',
				async () => ({ create: (config) => new LazyTestProvider(config, instanceCaps) }),
				{ capabilities: HINT_CAPS },
			)

			const { provider } = await ProviderRegistry.createAsync({ type: 'lazytest' })
			// The query runtime negotiates against the instance, not the registry:
			const resolved = resolveProviderCapabilities(provider)
			expect(resolved.supportsTools).toBe(true)
			expect(resolved.supportsFunctionCalling).toBe(false)
			expect(resolved.supportsVision).toBe(false)
		})
	})
})
