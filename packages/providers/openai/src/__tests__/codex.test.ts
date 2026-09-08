import { EditTool, ProviderRegistry } from '@namzu/sdk'
import type { ChatCompletionParams, ProviderRoute } from '@namzu/sdk'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toCodexInput, toCodexTools } from '../codex.js'
import { CODEX_CAPABILITIES, CodexProvider, registerCodex } from '../index.js'

const ROUTE: ProviderRoute = {
	providerId: 'codex',
	model: 'gpt-5.6-sol',
	chainIndex: 0,
}

function catalogueRow(slug: string, levels: readonly string[], defaultLevel?: string) {
	return {
		slug,
		supported_reasoning_levels: levels.map((effort) => ({ effort })),
		default_reasoning_level: defaultLevel,
	}
}

async function loadCatalogue(provider: CodexProvider, models: unknown[]) {
	const client = (provider as unknown as { client: { get: unknown } }).client
	client.get = vi.fn(async () => ({ models }))
	return provider.listModels()
}

beforeEach(() => {
	if (ProviderRegistry.isSupported('codex')) ProviderRegistry.unregister('codex')
})

describe('Codex provider registration', () => {
	it('registers a separate provider with an honest bounded capability set', () => {
		registerCodex()
		const { provider, capabilities } = ProviderRegistry.create({
			type: 'codex',
			accessToken: 'access',
			accountId: 'account',
			model: 'gpt-5.6-sol',
		})
		expect(provider).toBeInstanceOf(CodexProvider)
		expect(capabilities).toEqual(CODEX_CAPABILITIES)
		expect(capabilities.supportsNativeStructuredOutput).toBe(true)
		expect(provider.capabilities?.supportsNativeStructuredOutput).toBe(true)
		expect(capabilities).toMatchObject({
			supportsTools: true,
			supportsVision: true,
			supportsToolResultImages: true,
		})
	})

	it('discovers menus and defaults for model identifiers unknown to the driver', async () => {
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'fixture',
		})
		expect(provider.reasoningEffortLevelsFor('catalogue-new-model')).toBeUndefined()
		expect(provider.reasoningEffortLevelsFor('gpt-6-astra')).toBeUndefined()
		const models = await loadCatalogue(provider, [
			catalogueRow('catalogue-new-model', ['low', 'high', 'ultra'], 'high'),
			catalogueRow('different-model', ['none'], 'none'),
			catalogueRow('empty-model', []),
		])
		expect(models[0]).toMatchObject({
			id: 'catalogue-new-model',
			reasoningEffortLevels: ['low', 'high', 'ultra'],
			reasoningEffortDefault: 'high',
		})
		expect(provider.reasoningEffortLevelsFor('catalogue-new-model')).toEqual([
			'low',
			'high',
			'ultra',
		])
		expect(provider.reasoningEffortDefaultFor('catalogue-new-model')).toBe('high')
		expect(provider.reasoningEffortDefaultFor('different-model')).toBe('none')
		expect(provider.reasoningEffortLevelsFor('empty-model')).toEqual([])
		expect(provider.reasoningEffortDefaultFor('empty-model')).toBeUndefined()
	})

	it('does not guess from malformed, missing or partly unknown effort metadata', async () => {
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'fixture',
		})
		const models = await loadCatalogue(provider, [
			{ slug: 'missing' },
			catalogueRow('future-level', ['low', 'unrecognized-effort'], 'low'),
			catalogueRow('duplicate', ['high', 'high'], 'high'),
			{ slug: 'malformed', supported_reasoning_levels: ['high'] },
			{ slug: 'not-array', supported_reasoning_levels: 'high' },
			catalogueRow('bad-default', ['low', 'high'], 'ultra'),
			{ ...catalogueRow('hidden', ['high'], 'high'), visibility: 'hide' },
		])
		for (const name of [
			'missing',
			'future-level',
			'duplicate',
			'malformed',
			'not-array',
			'hidden',
		]) {
			expect(provider.reasoningEffortLevelsFor(name)).toBeUndefined()
			expect(provider.reasoningEffortDefaultFor(name)).toBeUndefined()
			expect(models.find((model) => model.id === name)?.reasoningEffortLevels).toBeUndefined()
		}
		expect(provider.reasoningEffortLevelsFor('bad-default')).toEqual(['low', 'high'])
		expect(provider.reasoningEffortDefaultFor('bad-default')).toBeUndefined()
		expect(models.some((model) => model.id === 'hidden')).toBe(false)
	})

	it('replaces obsolete cached metadata on a successful catalogue refresh', async () => {
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'fixture',
		})
		await loadCatalogue(provider, [
			catalogueRow('changing', ['low'], 'low'),
			catalogueRow('removed', ['high'], 'high'),
		])
		await loadCatalogue(provider, [catalogueRow('changing', ['medium', 'max'], 'max')])
		expect(provider.reasoningEffortLevelsFor('changing')).toEqual(['medium', 'max'])
		expect(provider.reasoningEffortDefaultFor('changing')).toBe('max')
		expect(provider.reasoningEffortLevelsFor('removed')).toBeUndefined()
		await loadCatalogue(provider, [{ slug: 'changing' }])
		expect(provider.reasoningEffortLevelsFor('changing')).toBeUndefined()
	})

	it('keeps the last successful snapshot when discovery fails or is cancelled', async () => {
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'fixture',
		})
		await loadCatalogue(provider, [catalogueRow('known', ['low'], 'low')])
		const client = (provider as unknown as { client: { get: unknown } }).client
		client.get = vi.fn(async () => {
			throw new Error('catalogue unavailable')
		})
		await expect(provider.listModels()).rejects.toThrow('catalogue unavailable')
		expect(provider.reasoningEffortLevelsFor('known')).toEqual(['low'])
		const controller = new AbortController()
		controller.abort(new Error('cancel discovery'))
		await expect(provider.listModels(controller.signal)).rejects.toThrow('cancel discovery')
		expect(provider.reasoningEffortDefaultFor('known')).toBe('low')
	})
})

describe('Codex request projection', () => {
	it('uses refreshed catalogue metadata for admission and leaves unknown effort to the backend', async () => {
		const create = vi.fn(async (_request: unknown) => (async function* () {})())
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'fixture',
		})
		;(provider as unknown as { client: unknown }).client = {
			responses: { create },
		}
		const send = async () => {
			for await (const _chunk of provider.chatStream({
				model: 'newly-discovered-model',
				messages: [{ role: 'user', content: 'fixture' }],
				effort: 'ultra',
			})) {
			}
		}
		await loadCatalogue(provider, [catalogueRow('newly-discovered-model', ['low'], 'low')])
		await expect(send()).rejects.toThrow(/is not supported/)
		expect(create).not.toHaveBeenCalled()
		await loadCatalogue(provider, [catalogueRow('newly-discovered-model', ['ultra'], 'ultra')])
		await send()
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			reasoning: { effort: 'ultra' },
		})
		await loadCatalogue(provider, [{ slug: 'newly-discovered-model' }])
		expect(provider.reasoningEffortLevelsFor('newly-discovered-model')).toBeUndefined()
		await send()
		expect(create).toHaveBeenCalledTimes(2)
	})

	it('leaves an omitted discovered-model effort to the backend default', async () => {
		const create = vi.fn(async (_request: unknown) => (async function* () {})())
		const provider = new CodexProvider({
			accessToken: 'fixture',
			accountId: 'fixture',
		})
		;(provider as unknown as { client: unknown }).client = {
			responses: { create },
		}
		await loadCatalogue(provider, [
			catalogueRow(
				'catalogue-request-model',
				['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
				'medium',
			),
		])
		for await (const _chunk of provider.chatStream({
			model: 'catalogue-request-model',
			messages: [{ role: 'user', content: 'fixture' }],
		})) {
		}
		expect(create).toHaveBeenCalledOnce()
		expect(create.mock.calls[0]?.[0]).not.toHaveProperty('reasoning')
	})

	it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
		'forwards discovered subscription effort %s unchanged',
		async (effort) => {
			const create = vi.fn(async (_request: unknown) => (async function* () {})())
			const provider = new CodexProvider({
				accessToken: 'fixture',
				accountId: 'fixture',
			})
			;(provider as unknown as { client: unknown }).client = {
				responses: { create },
			}
			await loadCatalogue(provider, [
				catalogueRow(
					'catalogue-request-model',
					['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
					'medium',
				),
			])
			for await (const _chunk of provider.chatStream({
				model: 'catalogue-request-model',
				messages: [{ role: 'user', content: 'fixture' }],
				effort,
			})) {
			}
			expect(create).toHaveBeenCalledOnce()
			expect(create.mock.calls[0]?.[0]).toMatchObject({
				model: 'catalogue-request-model',
				reasoning: { effort, summary: 'auto' },
			})
		},
	)

	it.each(['none', 'minimal'] as const)(
		'refuses discovered subscription effort %s before transport',
		async (effort) => {
			const create = vi.fn()
			const provider = new CodexProvider({
				accessToken: 'fixture',
				accountId: 'fixture',
			})
			;(provider as unknown as { client: unknown }).client = {
				responses: { create },
			}
			await loadCatalogue(provider, [
				catalogueRow(
					'catalogue-request-model',
					['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
					'medium',
				),
			])
			await expect(
				provider
					.chatStream({
						model: 'catalogue-request-model',
						messages: [{ role: 'user', content: 'fixture' }],
						effort,
					})
					[Symbol.asyncIterator]()
					.next(),
			).rejects.toThrow(/is not supported/)
			expect(create).not.toHaveBeenCalled()
		},
	)

	it('admits an advanced subscription level and refuses a false no-reasoning level', async () => {
		const create = vi.fn(async (_request: unknown) =>
			(async function* () {
				// Empty response is sufficient: this observer owns request admission.
			})(),
		)
		const provider = new CodexProvider({
			accessToken: 'access',
			accountId: 'account',
		})
		;(
			provider as unknown as {
				client: { responses: { create: typeof create } }
			}
		).client = {
			responses: { create },
		}

		await loadCatalogue(provider, [
			catalogueRow('gpt-5.6-sol', ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], 'low'),
		])
		for await (const _chunk of provider.chatStream({
			model: 'gpt-5.6-sol',
			messages: [{ role: 'user', content: 'hard task' }],
			effort: 'ultra',
		})) {
			// drain request admission
		}
		expect(create.mock.calls[0]?.[0]).toMatchObject({
			reasoning: { effort: 'ultra', summary: 'auto' },
		})

		await expect(
			provider
				.chatStream({
					model: 'gpt-5.6-sol',
					messages: [{ role: 'user', content: 'skip reasoning' }],
					effort: 'none',
				})
				[Symbol.asyncIterator]()
				.next(),
		).rejects.toThrow(/effort "none" is not supported/)
		expect(create).toHaveBeenCalledOnce()
	})

	it('maps user, assistant tool calls, tool results and schemas in provider order', () => {
		const messages: ChatCompletionParams['messages'] = [
			{ role: 'system', content: 'system' },
			{ role: 'user', content: 'use it' },
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 'call_1',
						type: 'function',
						function: { name: 'read', arguments: '{"x":1}' },
					},
				],
			},
			{ role: 'tool', toolCallId: 'call_1', content: 'done' },
		]
		expect(toCodexInput(messages, ROUTE)).toEqual([
			{ type: 'message', role: 'user', content: 'use it' },
			{
				type: 'function_call',
				call_id: 'call_1',
				name: 'read',
				arguments: '{"x":1}',
			},
			{ type: 'function_call_output', call_id: 'call_1', output: 'done' },
		])
		expect(
			toCodexTools({
				model: ROUTE.model,
				messages: [],
				tools: [
					{
						type: 'function',
						function: {
							name: 'read',
							description: 'Read',
							parameters: { type: 'object' },
						},
					},
				],
				enforceToolInputSchema: ['read'],
			}),
		).toEqual([
			{
				type: 'function',
				name: 'read',
				description: 'Read',
				parameters: { type: 'object' },
				strict: false,
			},
		])
	})

	it('keeps the production edit schema reachable instead of making a false strict claim', () => {
		expect(EditTool.modelInputSchema).toBeDefined()
		const sourceSchema = structuredClone(EditTool.modelInputSchema ?? {})
		const [projected] =
			toCodexTools({
				model: ROUTE.model,
				messages: [],
				tools: [
					{
						type: 'function',
						function: {
							name: EditTool.name,
							description: EditTool.description,
							parameters: sourceSchema,
						},
					},
				],
				enforceToolInputSchema: [EditTool.name],
			}) ?? []

		const functionTool = projected as
			| { strict: boolean; parameters: Record<string, unknown> }
			| undefined
		expect(functionTool?.strict).toBe(false)
		expect(functionTool?.parameters).toEqual(sourceSchema)
		expect(EditTool.modelInputSchema).toEqual(sourceSchema)
	})

	it('maps ordered user and tool images without flattening their bytes into text', () => {
		expect(
			toCodexInput(
				[
					{
						role: 'user',
						content: 'compare',
						attachments: [
							{ data: 'UE5H', mediaType: 'image/png' },
							{ data: 'SlBFRw==', mediaType: 'image/jpeg' },
						],
					},
					{
						role: 'tool',
						toolCallId: 'call_vision',
						content: [
							{ type: 'text', text: 'desktop' },
							{ type: 'image', data: 'V0VCUA==', mediaType: 'image/webp' },
							{ type: 'text', text: 'after' },
						],
					},
				],
				ROUTE,
			),
		).toEqual([
			{
				type: 'message',
				role: 'user',
				content: [
					{ type: 'input_text', text: 'compare' },
					{
						type: 'input_image',
						detail: 'auto',
						image_url: 'data:image/png;base64,UE5H',
					},
					{
						type: 'input_image',
						detail: 'auto',
						image_url: 'data:image/jpeg;base64,SlBFRw==',
					},
				],
			},
			{
				type: 'function_call_output',
				call_id: 'call_vision',
				output: [
					{ type: 'input_text', text: 'desktop' },
					{
						type: 'input_image',
						detail: 'auto',
						image_url: 'data:image/webp;base64,V0VCUA==',
					},
					{ type: 'input_text', text: 'after' },
				],
			},
		])
	})

	it('refuses rich shapes the subscription wire cannot honestly carry', () => {
		const user = (attachment: ChatCompletionParams['messages'][number]) =>
			toCodexInput([attachment], ROUTE)
		expect(() =>
			user({
				role: 'user',
				content: 'stored',
				attachments: [
					{
						type: 'stored',
						ref: 'ref_1',
						kind: 'image',
						mediaType: 'image/png',
					},
				],
			}),
		).toThrow(/unresolved stored attachment/)
		expect(() =>
			user({
				role: 'user',
				content: 'pdf',
				attachments: [
					{
						type: 'document',
						data: 'UERG',
						mediaType: 'application/pdf',
						name: 'x.pdf',
					},
				],
			}),
		).toThrow(/does not support document input/)
		expect(() =>
			user({
				role: 'user',
				content: 'svg',
				attachments: [{ data: 'U1ZH', mediaType: 'image/svg+xml' }],
			}),
		).toThrow(/image type 'image\/svg\+xml' is not supported/)
		expect(() =>
			toCodexInput(
				[
					{
						role: 'tool',
						toolCallId: 'pdf-result',
						content: [
							{
								type: 'document',
								data: 'UERG',
								mediaType: 'application/pdf',
								name: 'result.pdf',
							},
						],
					},
				],
				ROUTE,
			),
		).toThrow(/does not support document tool results/)
		expect(toCodexInput([{ role: 'tool', toolCallId: 'empty', content: [] }], ROUTE)).toEqual([
			{ type: 'function_call_output', call_id: 'empty', output: '' },
		])
	})
})

it('sends rich user and tool images on the complete subscription request', async () => {
	const create = vi.fn(async (_request: unknown) =>
		(async function* () {
			// Request projection is the observation; no response body is needed.
		})(),
	)
	const provider = new CodexProvider({
		accessToken: 'secret-access',
		accountId: 'account-1',
		model: ROUTE.model,
	})
	;(provider as unknown as { client: { responses: { create: typeof create } } }).client = {
		responses: { create },
	}

	for await (const _chunk of provider.chatStream({
		model: ROUTE.model,
		providerRoute: ROUTE,
		messages: [
			{
				role: 'user',
				content: 'inspect',
				attachments: [{ data: 'VVNFUg==', mediaType: 'image/png' }],
			},
			{
				role: 'assistant',
				content: null,
				toolCalls: [
					{
						id: 'call_screen',
						type: 'function',
						function: { name: 'screen', arguments: '{}' },
					},
				],
			},
			{
				role: 'tool',
				toolCallId: 'call_screen',
				content: [
					{ type: 'text', text: 'captured' },
					{ type: 'image', data: 'VE9PTA==', mediaType: 'image/jpeg' },
				],
			},
		],
	})) {
		// drain request admission
	}

	expect(provider.capabilities).toMatchObject({
		supportsVision: true,
		supportsToolResultImages: true,
	})
	const body = create.mock.calls[0]?.[0] as { input?: unknown[] }
	expect(body.input).toEqual([
		{
			type: 'message',
			role: 'user',
			content: [
				{ type: 'input_text', text: 'inspect' },
				{
					type: 'input_image',
					detail: 'auto',
					image_url: 'data:image/png;base64,VVNFUg==',
				},
			],
		},
		{
			type: 'function_call',
			call_id: 'call_screen',
			name: 'screen',
			arguments: '{}',
		},
		{
			type: 'function_call_output',
			call_id: 'call_screen',
			output: [
				{ type: 'input_text', text: 'captured' },
				{
					type: 'input_image',
					detail: 'auto',
					image_url: 'data:image/jpeg;base64,VE9PTA==',
				},
			],
		},
	])
	expect(JSON.stringify(body)).not.toContain('not renderable by this provider')
})

it('sends the Codex account-routed Responses wire and streams text, tools and replay state', async () => {
	const create = vi.fn(async (_request: unknown, _options?: unknown) =>
		(async function* () {
			yield { type: 'response.created', response: { id: 'resp_1' } }
			yield { type: 'response.output_text.delta', delta: 'hello' }
			yield {
				type: 'response.output_item.added',
				output_index: 1,
				item: {
					type: 'function_call',
					id: 'fc_1',
					call_id: 'call_1',
					name: 'read',
					arguments: '',
				},
			}
			yield {
				type: 'response.function_call_arguments.delta',
				item_id: 'fc_1',
				output_index: 1,
				delta: '{"x":1}',
			}
			yield {
				type: 'response.output_item.done',
				output_index: 1,
				item: {
					type: 'function_call',
					id: 'fc_1',
					call_id: 'call_1',
					name: 'read',
					arguments: '{"x":1}',
				},
			}
			yield {
				type: 'response.completed',
				response: {
					id: 'resp_1',
					output: [
						{
							type: 'message',
							id: '116b88f1-7300-4be5-a05d-f2a87105f095',
							role: 'assistant',
							status: 'completed',
							content: [{ type: 'output_text', text: 'hello', annotations: [] }],
						},
						{
							type: 'function_call',
							id: 'fc_1',
							call_id: 'call_1',
							name: 'read',
							arguments: '{"x":1}',
							status: 'completed',
						},
					],
					usage: {
						input_tokens: 3,
						output_tokens: 2,
						total_tokens: 5,
						input_tokens_details: { cached_tokens: 1 },
					},
				},
			}
		})(),
	)
	const provider = new CodexProvider({
		accessToken: 'secret-access',
		accountId: 'account-1',
		model: ROUTE.model,
	})
	;(provider as unknown as { client: { responses: { create: typeof create } } }).client = {
		responses: { create },
	}
	const chunks = []
	for await (const chunk of provider.chatStream({
		model: ROUTE.model,
		providerRoute: ROUTE,
		maxTokens: 64,
		messages: [
			{ role: 'system', content: 'identity' },
			{ role: 'user', content: 'hello' },
		],
	})) {
		chunks.push(chunk)
	}

	expect(create).toHaveBeenCalledOnce()
	const body = create.mock.calls[0]?.[0]
	expect(body).toMatchObject({
		model: ROUTE.model,
		stream: true,
		store: false,
		instructions: 'identity',
		input: [{ type: 'message', role: 'user', content: 'hello' }],
		tools: [],
		tool_choice: 'auto',
		parallel_tool_calls: true,
	})
	expect(body).not.toHaveProperty('max_output_tokens')
	expect(chunks.some((chunk) => chunk.delta.content === 'hello')).toBe(true)
	expect(chunks.some((chunk) => chunk.delta.toolCalls?.[0]?.id === 'call_1')).toBe(true)
	expect(chunks.at(-1)).toMatchObject({
		finishReason: 'tool_calls',
		usage: { promptTokens: 3, completionTokens: 2, cachedTokens: 1 },
		replayState: { kind: 'namzu.codex.responses', route: ROUTE },
	})
})

describe('Codex native response format', () => {
	it.each([true, false])(
		'preserves schema and strict=%s in Responses text.format',
		async (strict) => {
			const create = vi.fn(async (_request: unknown) => (async function* () {})())
			const provider = new CodexProvider({ accessToken: 'fixture', accountId: 'fixture' })
			;(provider as unknown as { client: unknown }).client = { responses: { create } }
			const schema = {
				type: 'object',
				properties: { score: { type: 'number' } },
				required: ['score'],
				additionalProperties: false,
			}
			for await (const _ of provider.chatStream({
				model: 'gpt-5.6-luna',
				messages: [{ role: 'user', content: 'Score' }],
				responseFormat: { type: 'json_schema', json_schema: { name: 'score', schema, strict } },
			})) {
			}
			expect(create.mock.calls[0]?.[0]).toMatchObject({
				text: { format: { type: 'json_schema', name: 'score', schema, strict } },
			})
			expect(create.mock.calls[0]?.[0]).not.toHaveProperty('response_format')
		},
	)
})
