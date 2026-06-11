import { DuplicateProviderError, ProviderRegistry } from '@namzu/sdk'
import type { ChatCompletionParams, LLMToolSchema } from '@namzu/sdk'
import { beforeEach, describe, expect, it } from 'vitest'
import { AnthropicProvider } from '../client.js'
import { ANTHROPIC_CAPABILITIES, registerAnthropic } from '../index.js'

// Ensure a clean slate between tests. The sdk pre-registers 'mock' on import
// via its sideEffects whitelist; we only need to clear 'anthropic' to make
// re-registration deterministic across tests.
beforeEach(() => {
	if (ProviderRegistry.isSupported('anthropic')) {
		ProviderRegistry.unregister('anthropic')
	}
})

describe('@namzu/anthropic', () => {
	describe('registerAnthropic()', () => {
		it("adds 'anthropic' to the ProviderRegistry", () => {
			expect(ProviderRegistry.isSupported('anthropic')).toBe(false)
			registerAnthropic()
			expect(ProviderRegistry.isSupported('anthropic')).toBe(true)
			expect(ProviderRegistry.listTypes()).toContain('anthropic')
		})

		it('throws DuplicateProviderError when called twice without options', () => {
			registerAnthropic()
			expect(() => registerAnthropic()).toThrowError(DuplicateProviderError)
		})

		it('allows re-registration when { replace: true } is passed', () => {
			registerAnthropic()
			expect(() => registerAnthropic({ replace: true })).not.toThrow()
			expect(ProviderRegistry.isSupported('anthropic')).toBe(true)
		})

		it('exposes capabilities through the registry after registration', () => {
			registerAnthropic()
			const caps = ProviderRegistry.getCapabilities('anthropic')
			expect(caps).toEqual(ANTHROPIC_CAPABILITIES)
		})
	})

	describe('ANTHROPIC_CAPABILITIES', () => {
		it('declares the expected capability flags', () => {
			expect(ANTHROPIC_CAPABILITIES).toEqual({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
			})
		})
	})

	describe('AnthropicProvider', () => {
		it('constructs with an apiKey and exposes provider identity', () => {
			const provider = new AnthropicProvider({ apiKey: 'test-key' })
			expect(provider.id).toBe('anthropic')
			expect(provider.name).toBe('Anthropic')
		})

		it('throws when constructed without an apiKey or authToken', () => {
			expect(() => new AnthropicProvider({} as any)).toThrow(/apiKey.*or.*authToken.*required/)
		})

		it('accepts an authToken instead of an apiKey (OAuth path)', () => {
			const provider = new AnthropicProvider({ authToken: 'cc-oauth-token' })
			expect(provider.id).toBe('anthropic')
		})

		it('creates via ProviderRegistry.create with the registered type', () => {
			registerAnthropic()
			const { provider, capabilities } = ProviderRegistry.create({
				type: 'anthropic',
				apiKey: 'test-key',
				model: 'claude-sonnet-4-5-20250929',
			})
			expect(provider.id).toBe('anthropic')
			expect(capabilities).toEqual(ANTHROPIC_CAPABILITIES)
		})

		it('does not enforce a provider-local stream idle timeout by default', async () => {
			const provider = new AnthropicProvider({
				apiKey: 'test-key',
				model: 'claude-sonnet-4-5-20250929',
			})
			;(provider as any).client = {
				messages: {
					create: async () => delayedAnthropicStream(10),
				},
			}

			const chunks = []
			for await (const chunk of provider.chatStream({
				model: 'claude-sonnet-4-5-20250929',
				messages: [{ role: 'user', content: 'hello' }],
				maxTokens: 100,
			})) {
				chunks.push(chunk)
			}

			expect(chunks.length).toBeGreaterThan(0)
		})

		it('supports an opt-in stream idle timeout for deployments that need it', async () => {
			const provider = new AnthropicProvider({
				apiKey: 'test-key',
				model: 'claude-sonnet-4-5-20250929',
				streamIdleTimeoutMs: 1,
			})
			;(provider as any).client = {
				messages: {
					create: async () => delayedAnthropicStream(20),
				},
			}

			const drain = async () => {
				for await (const _chunk of provider.chatStream({
					model: 'claude-sonnet-4-5-20250929',
					messages: [{ role: 'user', content: 'hello' }],
					maxTokens: 100,
				})) {
					// Drain the stream.
				}
			}

			await expect(drain()).rejects.toThrow(/stream idle/)
		})
	})
})

describe('AnthropicProvider — buildCreateParams', () => {
	const buildParams = (
		provider: AnthropicProvider,
		params: ChatCompletionParams,
		stream = false,
	): Record<string, any> =>
		(provider as any).buildCreateParams(params, stream) as Record<string, any>

	const makeProvider = () =>
		new AnthropicProvider({ apiKey: 'test-key', model: 'claude-sonnet-4-5-20250929' })

	const tools: LLMToolSchema[] = [
		{
			type: 'function',
			function: { name: 'alpha', description: 'first', parameters: { type: 'object' } },
		},
		{
			type: 'function',
			function: { name: 'beta', description: 'second', parameters: { type: 'object' } },
		},
	]

	describe('tool_choice mapping', () => {
		it("maps 'none' to the first-class {type:'none'} while KEEPING the tools param", () => {
			const body = buildParams(makeProvider(), {
				model: 'claude-sonnet-4-5-20250929',
				messages: [{ role: 'user', content: 'hi' }],
				tools,
				toolChoice: 'none',
			})
			expect(body.tool_choice).toEqual({ type: 'none' })
			expect(body.tools).toHaveLength(2)
		})

		it("maps 'auto' → auto, 'required' → any, and function → tool", () => {
			const base = {
				model: 'claude-sonnet-4-5-20250929',
				messages: [{ role: 'user' as const, content: 'hi' }],
				tools,
			}
			expect(buildParams(makeProvider(), { ...base, toolChoice: 'auto' }).tool_choice).toEqual({
				type: 'auto',
			})
			expect(buildParams(makeProvider(), { ...base, toolChoice: 'required' }).tool_choice).toEqual({
				type: 'any',
			})
			expect(
				buildParams(makeProvider(), {
					...base,
					toolChoice: { type: 'function', function: { name: 'alpha' } },
				}).tool_choice,
			).toEqual({ type: 'tool', name: 'alpha' })
		})

		it('omits tool_choice entirely when no tools are present', () => {
			const body = buildParams(makeProvider(), {
				model: 'claude-sonnet-4-5-20250929',
				messages: [{ role: 'user', content: 'hi' }],
				toolChoice: 'none',
			})
			expect(body.tools).toBeUndefined()
			expect(body.tool_choice).toBeUndefined()
		})

		it('maps parallelToolCalls:false to disable_parallel_tool_use on tool_choice', () => {
			const body = buildParams(makeProvider(), {
				model: 'claude-sonnet-4-5-20250929',
				messages: [{ role: 'user', content: 'hi' }],
				tools,
				parallelToolCalls: false,
			})
			expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true })
		})
	})

	describe('prompt caching', () => {
		const cachedParams = (): ChatCompletionParams => ({
			model: 'claude-sonnet-4-5-20250929',
			messages: [
				{ role: 'system', content: 'STATIC PREFIX', cacheHint: 'cache' },
				{ role: 'system', content: 'DYNAMIC SEGMENT', cacheHint: 'ephemeral' },
				{ role: 'user', content: 'hello' },
			],
			tools,
			cacheControl: { type: 'auto' },
		})

		it('emits zero cache_control blocks when cacheControl is not requested', () => {
			const params = cachedParams()
			params.cacheControl = undefined
			const body = buildParams(makeProvider(), params)
			expect(JSON.stringify(body)).not.toContain('cache_control')
			// System still arrives as cacheHint-preserving blocks.
			expect(body.system).toEqual([
				{ type: 'text', text: 'STATIC PREFIX' },
				{ type: 'text', text: 'DYNAMIC SEGMENT' },
			])
		})

		it('preserves system segment boundaries and marks only the cache-tagged block', () => {
			const body = buildParams(makeProvider(), cachedParams())
			expect(body.system).toEqual([
				{ type: 'text', text: 'STATIC PREFIX', cache_control: { type: 'ephemeral' } },
				{ type: 'text', text: 'DYNAMIC SEGMENT' },
			])
		})

		it('marks the tools-array tail and the last message block', () => {
			const body = buildParams(makeProvider(), cachedParams())
			const bodyTools = body.tools as Record<string, unknown>[]
			expect(bodyTools[0]?.cache_control).toBeUndefined()
			expect(bodyTools[1]?.cache_control).toEqual({ type: 'ephemeral' })

			const messages = body.messages as Array<{ content: unknown }>
			expect(messages[messages.length - 1]?.content).toEqual([
				{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } },
			])
		})

		it('places the final breakpoint on the last tool_result block of a tool turn', () => {
			const params = cachedParams()
			params.messages = [
				{ role: 'system', content: 'STATIC PREFIX', cacheHint: 'cache' },
				{ role: 'user', content: 'run the tool' },
				{
					role: 'assistant',
					content: null,
					toolCalls: [
						{ id: 'tu_1', type: 'function', function: { name: 'alpha', arguments: '{}' } },
					],
				},
				{ role: 'tool', content: 'tool says hi', toolCallId: 'tu_1' },
			]
			const body = buildParams(makeProvider(), params)
			const messages = body.messages as Array<{ content: unknown }>
			expect(messages[messages.length - 1]?.content).toEqual([
				{
					type: 'tool_result',
					tool_use_id: 'tu_1',
					content: 'tool says hi',
					cache_control: { type: 'ephemeral' },
				},
			])
		})

		it('keeps the Claude Code identity block FIRST on the OAuth path', () => {
			const provider = new AnthropicProvider({ authToken: 'cc-oauth-token' })
			const body = buildParams(provider, cachedParams())
			const system = body.system as Array<{ text: string; cache_control?: unknown }>
			expect(system[0]?.text).toMatch(/^You are Claude Code/)
			expect(system[0]?.cache_control).toBeUndefined()
			expect(system[1]).toEqual({
				type: 'text',
				text: 'STATIC PREFIX',
				cache_control: { type: 'ephemeral' },
			})
		})
	})
})

async function* delayedAnthropicStream(delayMs: number) {
	yield {
		type: 'message_start',
		message: {
			id: 'msg_test',
			usage: { input_tokens: 1, output_tokens: 0 },
		},
	}
	await new Promise((resolve) => setTimeout(resolve, delayMs))
	yield {
		type: 'content_block_start',
		index: 0,
		content_block: { type: 'text' },
	}
	yield {
		type: 'content_block_delta',
		index: 0,
		delta: { type: 'text_delta', text: 'ok' },
	}
	yield {
		type: 'content_block_stop',
		index: 0,
	}
	yield {
		type: 'message_delta',
		delta: { stop_reason: 'end_turn' },
		usage: { output_tokens: 1 },
	}
	yield {
		type: 'message_stop',
	}
}
