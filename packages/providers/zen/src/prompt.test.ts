import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModelV3, LanguageModelV3Content } from '@ai-sdk/provider'
import type { AssistantMessage, ChatCompletionParams, Message, ProviderRoute } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import type { ZenProtocol } from './models.js'
import { createReplayState, toModelPrompt, toReasoningBlocks } from './prompt.js'

const ROUTE: ProviderRoute = { providerId: 'configured-zen', model: 'test-model', chainIndex: 0 }
const INPUT: ChatCompletionParams = {
	model: ROUTE.model,
	messages: [{ role: 'user', content: 'Find a file.' }],
}
const CALL = {
	id: 'call/opaque-1',
	type: 'function' as const,
	function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
}

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('Fixture is missing a required value.')
	return value
}

function materialize(content: LanguageModelV3Content[], protocol: ZenProtocol): AssistantMessage {
	return {
		role: 'assistant',
		content:
			content
				.filter((part) => part.type === 'text')
				.map((part) => part.text)
				.join('') || null,
		reasoning: toReasoningBlocks(content),
		toolCalls: content.flatMap((part) =>
			part.type === 'tool-call'
				? [
						{
							id: part.toolCallId,
							type: 'function' as const,
							function: { name: part.toolName, arguments: part.input },
						},
					]
				: [],
		),
		source: {
			type: 'model',
			...ROUTE,
			replayState: createReplayState(INPUT, ROUTE, 'zen', protocol, content),
		},
	}
}

function nativeReasoning(
	metadata: Record<string, Record<string, string>>,
): LanguageModelV3Content[] {
	return [
		{ type: 'reasoning', text: 'Inspect the source.', providerMetadata: metadata },
		{ type: 'text', text: 'Reading it.' },
		{
			type: 'tool-call',
			toolCallId: CALL.id,
			toolName: CALL.function.name,
			input: CALL.function.arguments,
		},
	]
}

function convert(messages: Message[], protocol: ZenProtocol = 'messages') {
	return toModelPrompt({ model: ROUTE.model, messages }, ROUTE, 'zen', protocol)
}

describe('Zen prompt conversion', () => {
	it('preserves roles, inline images and named documents as native file parts', () => {
		expect(
			convert([
				{ role: 'system', content: 'Read the supplied context.' },
				{
					role: 'user',
					content: 'Inspect these.',
					attachments: [
						{ data: 'aW1hZ2U=', mediaType: 'image/png' },
						{ type: 'document', data: 'cGRm', mediaType: 'application/pdf', name: 'report.pdf' },
					],
				},
			]),
		).toEqual([
			{ role: 'system', content: 'Read the supplied context.' },
			{
				role: 'user',
				content: [
					{ type: 'text', text: 'Inspect these.' },
					{ type: 'file', data: 'aW1hZ2U=', mediaType: 'image/png' },
					{ type: 'file', data: 'cGRm', mediaType: 'application/pdf', filename: 'report.pdf' },
				],
			},
		])
	})

	it('omits only images with a valid durable delivery verdict', () => {
		const prompt = convert([
			{
				role: 'user',
				content: 'Saved images',
				attachments: [
					{ data: 'bad', mediaType: 'image/png', modelOmission: { reason: 'invalid-image' } },
					{ data: 'good', mediaType: 'image/png', modelOmission: { reason: 'invented' } as never },
				],
			},
		])
		expect(prompt[0]).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'Saved images' },
				{ type: 'file', data: 'good', mediaType: 'image/png' },
			],
		})
	})

	it('refuses unresolved references and citation requests before transport', () => {
		expect(() =>
			convert([
				{
					role: 'user',
					content: '',
					attachments: [
						{ type: 'stored', ref: 'secret-ref', mediaType: 'application/pdf', kind: 'document' },
					],
				},
			]),
		).toThrow('resolved')
		expect(() =>
			convert([
				{
					role: 'user',
					content: '',
					attachments: [
						{
							type: 'document',
							data: 'secret-bytes',
							mediaType: 'application/pdf',
							citations: true,
						},
					],
				},
			]),
		).toThrow('citations')
	})

	it('keeps opaque tool IDs, resolves names from earlier calls and marks failures', () => {
		const prompt = convert([
			{ role: 'assistant', content: null, toolCalls: [CALL, { ...CALL, id: 'second' }] },
			{ role: 'tool', toolCallId: 'second', content: 'permission denied', isError: true },
			{ role: 'tool', toolCallId: CALL.id, content: 'source text' },
		])
		expect(prompt[0]).toMatchObject({
			role: 'assistant',
			content: [
				{ type: 'tool-call', toolCallId: CALL.id, input: { path: 'a.ts' } },
				{ toolCallId: 'second' },
			],
		})
		expect(prompt[1]).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: 'second',
					toolName: 'read_file',
					output: { type: 'error-text', value: 'permission denied' },
				},
			],
		})
		expect(prompt[2]).toEqual({
			role: 'tool',
			content: [
				{
					type: 'tool-result',
					toolCallId: CALL.id,
					toolName: 'read_file',
					output: { type: 'text', value: 'source text' },
				},
			],
		})
	})

	it('refuses orphan results and malformed call JSON without echoing payloads', () => {
		expect(() =>
			convert([{ role: 'tool', toolCallId: 'private-id', content: 'private-data' }]),
		).toThrow('preceding tool call')
		expect(() =>
			convert([
				{
					role: 'assistant',
					content: null,
					toolCalls: [{ ...CALL, function: { name: 'f', arguments: 'private malformed input' } }],
				},
			]),
		).toThrow('invalid JSON arguments')
	})

	it('retains rich result order and bytes for native content-capable protocols', () => {
		const messages: Message[] = [
			{ role: 'assistant', content: null, toolCalls: [CALL] },
			{
				role: 'tool',
				toolCallId: CALL.id,
				content: [
					{ type: 'text', text: 'A screenshot' },
					{ type: 'image', data: 'aW1hZ2U=', mediaType: 'image/png' },
					{
						type: 'image',
						data: 'bad',
						mediaType: 'image/png',
						modelOmission: { reason: 'provider-rejected' },
					},
					{ type: 'document', data: 'cGRm', mediaType: 'application/pdf', name: 'report.pdf' },
				],
			},
		]
		for (const protocol of ['messages', 'responses', 'google'] as const) {
			expect(convert(messages, protocol)[1]).toMatchObject({
				content: [
					{
						output: {
							type: 'content',
							value: [
								{ type: 'text', text: 'A screenshot' },
								{ type: 'image-data', data: 'aW1hZ2U=', mediaType: 'image/png' },
								{
									type: 'file-data',
									data: 'cGRm',
									mediaType: 'application/pdf',
									filename: 'report.pdf',
								},
							],
						},
					},
				],
			})
		}
		expect(() => convert(messages, 'chat')).toThrow('rich tool results')
		expect(() =>
			convert([required(messages[0]), { ...required(messages[1]), isError: true } as Message]),
		).toThrow('failure status')
	})

	it('keeps text-only block failures and omits empty foreign reasoning turns', () => {
		expect(
			convert([
				{
					role: 'assistant',
					content: null,
					reasoning: [{ type: 'thinking', text: 'foreign', signature: 'secret' }],
				},
				{ role: 'assistant', content: null, toolCalls: [CALL] },
				{
					role: 'tool',
					toolCallId: CALL.id,
					isError: true,
					content: [
						{ type: 'text', text: 'first' },
						{ type: 'text', text: 'second' },
					],
				},
			]),
		).toHaveLength(2)
	})
})

describe('Zen native replay ownership', () => {
	it('round-trips signed blocks and native interleaving through JSON persistence', () => {
		const content = nativeReasoning({ anthropic: { signature: 'sig-opaque' } })
		content.push({
			type: 'reasoning',
			text: '',
			providerMetadata: { anthropic: { redactedData: 'opaque-redaction' } },
		})
		const message = JSON.parse(JSON.stringify(materialize(content, 'messages'))) as AssistantMessage
		const prompt = convert([...INPUT.messages, message])
		expect(prompt[1]).toEqual({
			role: 'assistant',
			content: [
				{
					type: 'reasoning',
					text: 'Inspect the source.',
					providerOptions: { anthropic: { signature: 'sig-opaque' } },
				},
				{ type: 'text', text: 'Reading it.' },
				{ type: 'tool-call', toolCallId: CALL.id, toolName: 'read_file', input: { path: 'a.ts' } },
				{
					type: 'reasoning',
					text: '',
					providerOptions: { anthropic: { redactedData: 'opaque-redaction' } },
				},
			],
		})
	})

	it.each([
		'source',
		'chain',
		'model',
		'service',
		'protocol',
		'text',
		'arguments',
		'reasoning',
		'prefix',
		'state',
	] as const)('invalidates replay when %s changes', (change) => {
		const message = materialize(
			nativeReasoning({ anthropic: { signature: 'sig-opaque' } }),
			'messages',
		)
		let messages: Message[] = [...INPUT.messages, message]
		let route = ROUTE
		let service: 'zen' | 'go' = 'zen'
		let protocol: ZenProtocol = 'messages'
		let model = ROUTE.model
		if (change === 'source')
			message.source = { ...required(message.source), providerId: 'other-tenant' }
		if (change === 'chain') route = { ...ROUTE, chainIndex: 1 }
		if (change === 'model') model = 'different-model'
		if (change === 'service') service = 'go'
		if (change === 'protocol') protocol = 'responses'
		if (change === 'text') message.content = 'Compacted summary'
		if (change === 'arguments')
			required(message.toolCalls?.[0]).function.arguments = '{"path":"other.ts"}'
		if (change === 'reasoning')
			message.reasoning = [{ type: 'thinking', text: 'changed', signature: 'sig-opaque' }]
		if (change === 'prefix') messages = [{ role: 'user', content: 'Changed request' }, message]
		if (change === 'state')
			(required(message.source).replayState as { content: unknown[] }).content = [
				{ type: 'reasoning', text: 'forged' },
			]
		const prompt = toModelPrompt({ model, messages }, route, service, protocol)
		expect(JSON.stringify(prompt)).not.toContain('providerOptions')
		expect(JSON.stringify(prompt)).not.toContain('sig-opaque')
		expect(prompt.at(-1)).toMatchObject({
			role: 'assistant',
			content: [{ type: 'text', text: message.content }, { type: 'tool-call' }],
		})
	})

	it('matches semantically identical JSON arguments without depending on whitespace', () => {
		const message = materialize(nativeReasoning({ anthropic: { signature: 'sig' } }), 'messages')
		required(message.toolCalls?.[0]).function.arguments = '{ "path": "a.ts" }'
		expect(JSON.stringify(convert([...INPUT.messages, message]))).toContain('sig')
	})

	it('never claims valid replay for truncated or unsupported native parts', () => {
		expect(
			createReplayState(INPUT, ROUTE, 'zen', 'messages', [
				{ type: 'tool-call', toolCallId: 'a', toolName: 'f', input: '{"truncated":' },
			]),
		).toBeUndefined()
		expect(
			createReplayState(INPUT, ROUTE, 'zen', 'responses', [
				{ type: 'tool-call', toolCallId: 'a', toolName: 'f', input: '{}', providerExecuted: true },
			]),
		).toBeUndefined()
		expect(
			createReplayState(INPUT, ROUTE, 'zen', 'messages', [
				{ type: 'file', mediaType: 'image/png', data: 'abc' },
			]),
		).toBeUndefined()
	})

	it('snapshots metadata without keeping mutable references or undefined fields', () => {
		const content = nativeReasoning({ anthropic: { signature: 'original' } })
		required(content[0]?.providerMetadata?.anthropic).unused = undefined
		const message = materialize(content, 'messages')
		required(content[0]?.providerMetadata?.anthropic).signature = 'changed later'
		expect(JSON.stringify(convert([...INPUT.messages, message]))).toContain('original')
		expect(JSON.stringify(convert([...INPUT.messages, message]))).not.toContain('changed later')
	})
})

describe('official V3 adapters consume replay metadata', () => {
	async function requestBody(
		factory: (fetch: typeof globalThis.fetch) => LanguageModelV3,
		message: AssistantMessage,
		protocol: ZenProtocol,
		following: Message[] = [],
	): Promise<Record<string, unknown>> {
		let body: Record<string, unknown> | undefined
		const fetch: typeof globalThis.fetch = async (_input, init) => {
			body = JSON.parse(String(init?.body)) as Record<string, unknown>
			return new Response(
				JSON.stringify({
					error: { message: 'intentional fixture rejection', type: 'invalid_request_error' },
				}),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			)
		}
		await expect(
			factory(fetch).doStream({
				prompt: convert([...INPUT.messages, message, ...following], protocol),
				providerOptions: { openai: { store: false } },
			}),
		).rejects.toThrow()
		expect(body).toBeDefined()
		return required(body)
	}

	it('retains failed-tool semantics in all four native request formats', async () => {
		const factories: {
			protocol: ZenProtocol
			create: (fetch: typeof globalThis.fetch) => LanguageModelV3
		}[] = [
			{
				protocol: 'messages',
				create: (fetch) => createAnthropic({ apiKey: 'fixture', fetch })('claude-sonnet-4-5'),
			},
			{
				protocol: 'responses',
				create: (fetch) => createOpenAI({ apiKey: 'fixture', fetch }).responses('gpt-5'),
			},
			{
				protocol: 'google',
				create: (fetch) =>
					createGoogleGenerativeAI({ apiKey: 'fixture', fetch })('gemini-3-flash-preview'),
			},
			{
				protocol: 'chat',
				create: (fetch) =>
					createOpenAICompatible({
						name: 'opencode',
						baseURL: 'https://fixture.invalid/v1',
						apiKey: 'fixture',
						fetch,
					})('fixture-model'),
			},
		]
		for (const { protocol, create } of factories) {
			const message = materialize(
				[
					{
						type: 'tool-call',
						toolCallId: CALL.id,
						toolName: 'read_file',
						input: CALL.function.arguments,
					},
				],
				protocol,
			)
			const body = await requestBody(create, message, protocol, [
				{ role: 'tool', toolCallId: CALL.id, content: 'permission denied', isError: true },
			])
			if (protocol === 'messages') {
				expect(JSON.stringify(body)).toContain('"is_error":true')
				expect(JSON.stringify(body)).toContain('"content":"permission denied"')
			} else {
				expect(JSON.stringify(body)).toContain('Tool execution failed.\\npermission denied')
			}
		}
	})

	it('replays Anthropic thinking signatures and redacted blocks on the wire', async () => {
		const content = nativeReasoning({ anthropic: { signature: 'signed-native' } })
		content.splice(1, 0, {
			type: 'reasoning',
			text: '',
			providerMetadata: { anthropic: { redactedData: 'encrypted-native' } },
		})
		const body = await requestBody(
			(fetch) => createAnthropic({ apiKey: 'fixture', fetch })('claude-sonnet-4-5'),
			materialize(content, 'messages'),
			'messages',
		)
		expect(body.messages).toMatchObject([
			{ role: 'user' },
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Inspect the source.', signature: 'signed-native' },
					{ type: 'redacted_thinking', data: 'encrypted-native' },
					{ type: 'text', text: 'Reading it.' },
					{ type: 'tool_use', id: CALL.id, name: 'read_file', input: { path: 'a.ts' } },
				],
			},
		])
	})

	it('replays Responses encrypted reasoning with stateless history', async () => {
		const content = nativeReasoning({
			openai: { itemId: 'rs_native', reasoningEncryptedContent: 'ciphertext' },
		})
		const body = await requestBody(
			(fetch) => createOpenAI({ apiKey: 'fixture', fetch }).responses('gpt-5'),
			materialize(content, 'responses'),
			'responses',
		)
		expect(body.input).toContainEqual(
			expect.objectContaining({
				type: 'reasoning',
				id: 'rs_native',
				encrypted_content: 'ciphertext',
			}),
		)
	})

	it('replays Google thought signatures on tool calls', async () => {
		const content: LanguageModelV3Content[] = [
			{
				type: 'tool-call',
				toolCallId: CALL.id,
				toolName: 'read_file',
				input: CALL.function.arguments,
				providerMetadata: { google: { thoughtSignature: 'gemini-native' } },
			},
		]
		const body = await requestBody(
			(fetch) => createGoogleGenerativeAI({ apiKey: 'fixture', fetch })('gemini-3-flash-preview'),
			materialize(content, 'google'),
			'google',
		)
		expect(body.contents).toMatchObject([
			{ role: 'user' },
			{
				role: 'model',
				parts: [
					{
						functionCall: { name: 'read_file', args: { path: 'a.ts' } },
						thoughtSignature: 'gemini-native',
					},
				],
			},
		])
	})

	it('normalizes compatible namespace tool signatures to the SDK replay namespace', async () => {
		const content: LanguageModelV3Content[] = [
			{
				type: 'tool-call',
				toolCallId: CALL.id,
				toolName: 'read_file',
				input: CALL.function.arguments,
				providerMetadata: { opencode: { thoughtSignature: 'compatible-native' } },
			},
		]
		const body = await requestBody(
			(fetch) =>
				createOpenAICompatible({
					name: 'opencode',
					baseURL: 'https://fixture.invalid/v1',
					apiKey: 'fixture',
					fetch,
				})('fixture-model'),
			materialize(content, 'chat'),
			'chat',
		)
		expect(body.messages).toMatchObject([
			{ role: 'user' },
			{
				role: 'assistant',
				tool_calls: [
					{ id: CALL.id, extra_content: { google: { thought_signature: 'compatible-native' } } },
				],
			},
		])
	})
})
