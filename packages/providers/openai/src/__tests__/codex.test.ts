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
		expect(capabilities).toMatchObject({
			supportsTools: true,
			supportsVision: true,
			supportsToolResultImages: true,
		})
	})

	it('publishes the subscription catalogue levels and model-owned defaults', () => {
		const provider = new CodexProvider({
			accessToken: 'access',
			accountId: 'account',
		})

		expect(provider.reasoningEffortLevelsFor('gpt-5.6-sol')).toEqual([
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
			'ultra',
		])
		expect(provider.reasoningEffortDefaultFor('gpt-5.6-sol')).toBe('low')
		expect(provider.reasoningEffortDefaultFor('gpt-5.6-terra')).toBe('medium')
		expect(provider.reasoningEffortLevelsFor('gpt-5.6-luna')).toEqual([
			'low',
			'medium',
			'high',
			'xhigh',
			'max',
		])
		expect(provider.reasoningEffortLevelsFor('gateway/future-model')).toBeUndefined()
		expect(provider.reasoningEffortDefaultFor('gateway/future-model')).toBeUndefined()
	})
})

describe('Codex request projection', () => {
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
		;(provider as unknown as { client: { responses: { create: typeof create } } }).client = {
			responses: { create },
		}

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
					{ type: 'input_image', detail: 'auto', image_url: 'data:image/png;base64,UE5H' },
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
				attachments: [{ type: 'stored', ref: 'ref_1', kind: 'image', mediaType: 'image/png' }],
			}),
		).toThrow(/unresolved stored attachment/)
		expect(() =>
			user({
				role: 'user',
				content: 'pdf',
				attachments: [
					{ type: 'document', data: 'UERG', mediaType: 'application/pdf', name: 'x.pdf' },
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
							id: 'msg_1',
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
