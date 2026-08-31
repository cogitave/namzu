import {
	DuplicateProviderError,
	ProviderRegistry,
	ToolRegistry,
	createComputerUseTool,
} from '@namzu/sdk'
import type { ChatCompletionParams, ComputerUseHost, LLMToolSchema } from '@namzu/sdk'
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
				supportsVision: true,
				supportsDocuments: true,
				supportsToolResultImages: true,
				supportsToolResultDocuments: false,
			})
		})

		it('is exposed on the provider instance for runtime negotiation', () => {
			const provider = new AnthropicProvider({ apiKey: 'test-key' })
			expect(provider.capabilities).toEqual(ANTHROPIC_CAPABILITIES)
		})
	})

	describe('AnthropicProvider', () => {
		it('constructs with an apiKey and exposes provider identity', () => {
			const provider = new AnthropicProvider({ apiKey: 'test-key' })
			expect(provider.id).toBe('anthropic')
			expect(provider.name).toBe('Anthropic')
		})

		it('throws when constructed without an apiKey or authToken', () => {
			expect(() => new AnthropicProvider({})).toThrow(/apiKey.*or.*authToken.*required/)
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
			;(provider as unknown as { client: unknown }).client = {
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
			;(provider as unknown as { client: unknown }).client = {
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
	type AnthropicRequestBody = Record<string, unknown> & {
		tools?: Record<string, unknown>[]
	}

	const buildParams = (
		provider: AnthropicProvider,
		params: ChatCompletionParams,
		stream = false,
	): AnthropicRequestBody =>
		(
			provider as unknown as {
				buildCreateParams(input: ChatCompletionParams, useStream: boolean): AnthropicRequestBody
			}
		).buildCreateParams(params, stream)

	const makeProvider = () =>
		new AnthropicProvider({
			apiKey: 'test-key',
			model: 'claude-sonnet-4-5-20250929',
		})

	const tools: LLMToolSchema[] = [
		{
			type: 'function',
			function: {
				name: 'alpha',
				description: 'first',
				parameters: { type: 'object' },
			},
		},
		{
			type: 'function',
			function: {
				name: 'beta',
				description: 'second',
				parameters: { type: 'object' },
			},
		},
	]

	it('sends the actual computer-use model schema without moving it in the CLI tool roster', () => {
		const host = {
			id: 'test-desktop',
			capabilities: {
				displayServer: 'x11',
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: true,
				clipboard: true,
			},
			getDisplayGeometry: async () => ({ width: 1, height: 1, scaleFactor: 1 }),
			execute: async () => ({ type: 'ok' as const }),
		} satisfies ComputerUseHost
		const registry = new ToolRegistry()
		registry.register(createComputerUseTool(host))
		const registeredComputerUse = registry.toLLMTools()[0]
		if (!registeredComputerUse) throw new Error('computer_use did not reach the model tool catalog')
		const sourceSchema = registeredComputerUse.function.parameters
		const names = [
			'bash',
			'edit',
			'glob',
			'grep',
			'job',
			'read',
			'write',
			'search_memory',
			'read_memory',
			'save_memory',
			'computer_use',
			'search_tools',
			'Agent',
		] as const
		const roster: LLMToolSchema[] = names.map((name) => ({
			type: 'function',
			function: {
				name,
				description: name,
				parameters: name === 'computer_use' ? sourceSchema : { type: 'object' },
			},
		}))

		const body = buildParams(makeProvider(), {
			model: 'claude-sonnet-4-6',
			messages: [{ role: 'user', content: 'hello' }],
			tools: roster,
			cacheControl: { type: 'auto' },
		})

		expect(body.tools?.map((tool) => tool.name)).toEqual(names)
		const computerUse = body.tools?.[10]?.input_schema as Record<string, unknown>
		expect(sourceSchema).toMatchObject({ type: 'object', required: ['type'] })
		expect(computerUse.type).toBe('object')
		expect(computerUse).not.toHaveProperty('anyOf')
		expect(computerUse).not.toHaveProperty('oneOf')
		expect(computerUse).not.toHaveProperty('allOf')
		expect(
			(
				(computerUse.properties as Record<string, Record<string, unknown>>).type as Record<
					string,
					unknown
				>
			).enum,
		).toEqual([
			'screenshot',
			'cursor_position',
			'mouse_move',
			'mouse_click',
			'mouse_drag',
			'scroll',
			'type_text',
			'key',
		])
		expect(body.tools?.filter((tool) => 'cache_control' in tool).map((tool) => tool.name)).toEqual([
			'Agent',
		])
	})

	it.each(['anyOf', 'oneOf', 'allOf'] as const)(
		'refuses a root %s before it reaches the provider wire, even beside type object',
		(keyword) => {
			for (const withType of [false, true]) {
				expect(() =>
					buildParams(makeProvider(), {
						model: 'claude-sonnet-4-6',
						messages: [{ role: 'user', content: 'hello' }],
						tools: [
							{
								type: 'function',
								function: {
									name: 'root_union',
									description: 'Root union',
									parameters: {
										...(withType ? { type: 'object' } : {}),
										[keyword]: [{ type: 'object' }],
									},
								},
							},
						],
					}),
				).toThrow(new RegExp(`root_union.*${keyword}.*modelInputSchema`, 'i'))
			}
		},
	)

	it('allows nested combinators because only the custom input root is forbidden', () => {
		const body = buildParams(makeProvider(), {
			model: 'claude-sonnet-4-6',
			messages: [{ role: 'user', content: 'hello' }],
			tools: [
				{
					type: 'function',
					function: {
						name: 'nested_union',
						description: 'Nested union',
						parameters: {
							type: 'object',
							properties: {
								value: { anyOf: [{ type: 'integer' }, { const: 'end' }] },
							},
						},
					},
				},
			],
		})

		expect(body.tools?.[0]?.input_schema).toMatchObject({
			type: 'object',
			properties: { value: { anyOf: [{ type: 'integer' }, { const: 'end' }] } },
		})
	})

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
			expect(body.tool_choice).toEqual({
				type: 'auto',
				disable_parallel_tool_use: true,
			})
		})
	})

	describe('strict tool input mapping', () => {
		const base = (model: string): ChatCompletionParams => ({
			model,
			messages: [{ role: 'user', content: 'hi' }],
			tools,
			enforceToolInputSchema: ['alpha'],
		})

		it.each([
			'claude-haiku-4-5-20251001',
			'claude-sonnet-4-6',
			'claude-opus-5',
			'anthropic/claude-fable-5',
			'claude-mythos-preview',
		])('enables only named tools for supported model %s', (model) => {
			const body = buildParams(makeProvider(), base(model))
			expect(body.tools?.[0]).toMatchObject({ name: 'alpha', strict: true })
			expect(body.tools?.[1]).toEqual({
				name: 'beta',
				description: 'second',
				input_schema: { type: 'object' },
			})
		})

		it.each([
			'claude-3-5-sonnet-20241022',
			'proxy-production-alias',
			'proxy-production-claude-opus-5-legacy',
			'not-claude-sonnet-4-5-compatible',
			'claude-mythos-preview-shadow',
		])('falls back to runtime validation for unsupported or unknown model %s', (model) => {
			const body = buildParams(makeProvider(), base(model))
			expect(JSON.stringify(body.tools)).not.toContain('"strict"')
		})

		it('uses the per-call model instead of the configured default in auto mode', () => {
			const provider = new AnthropicProvider({
				apiKey: 'test-key',
				model: 'claude-opus-5',
			})
			const body = buildParams(provider, base('proxy-production-alias'))
			expect(JSON.stringify(body.tools)).not.toContain('"strict"')
		})

		it('supports explicit on/off overrides for compatible aliases and proxies', () => {
			const on = new AnthropicProvider({
				apiKey: 'test-key',
				model: 'proxy-production-alias',
				strictToolUse: 'on',
			})
			expect(
				buildParams(on, {
					...base(''),
					model: '',
				}).tools?.[0],
			).toMatchObject({ strict: true })

			const off = new AnthropicProvider({
				apiKey: 'test-key',
				model: 'claude-opus-5',
				strictToolUse: 'off',
			})
			expect(JSON.stringify(buildParams(off, base('claude-opus-5')).tools)).not.toContain(
				'"strict"',
			)
		})

		it('ignores empty and unknown enforcement names', () => {
			for (const names of [[], ['unknown_tool']]) {
				const body = buildParams(makeProvider(), {
					...base('claude-opus-5'),
					enforceToolInputSchema: names,
				})
				expect(JSON.stringify(body.tools)).not.toContain('"strict"')
			}
		})

		it('serializes the reviewed model schema unchanged without unsupported constraints', () => {
			const schema = {
				type: 'object',
				properties: {
					path: { type: 'string' },
					old_string: { type: 'string' },
					new_string: { type: 'string' },
					replace_all: { type: 'boolean' },
				},
				required: ['path', 'old_string', 'new_string'],
				additionalProperties: false,
			}
			const body = buildParams(makeProvider(), {
				model: 'claude-opus-5',
				messages: [{ role: 'user', content: 'append' }],
				tools: [
					{
						type: 'function',
						function: {
							name: 'edit',
							description: 'Edit',
							parameters: schema,
						},
					},
				],
				enforceToolInputSchema: ['edit'],
			})

			expect(body.tools?.[0]).toEqual({
				name: 'edit',
				description: 'Edit',
				input_schema: schema,
				strict: true,
			})
			expect(JSON.stringify(body.tools)).not.toContain('"minimum"')
		})

		it('coexists with cache_control on the tools-array tail', () => {
			const body = buildParams(makeProvider(), {
				...base('claude-opus-5'),
				enforceToolInputSchema: ['beta'],
				cacheControl: { type: 'auto' },
			})
			expect(body.tools?.[0]).not.toHaveProperty('strict')
			expect(body.tools?.[1]).toMatchObject({
				name: 'beta',
				strict: true,
				cache_control: { type: 'ephemeral' },
			})
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
				{
					type: 'text',
					text: 'STATIC PREFIX',
					cache_control: { type: 'ephemeral' },
				},
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
						{
							id: 'tu_1',
							type: 'function',
							function: { name: 'alpha', arguments: '{}' },
						},
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
			const system = body.system as Array<{
				text: string
				cache_control?: unknown
			}>
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
