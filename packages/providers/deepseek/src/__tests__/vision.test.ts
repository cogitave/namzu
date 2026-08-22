import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	MCPReconnectOptionsSchema,
	ToolRegistry,
	defineTool,
	drainQuery,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DeepSeekProvider, toDeepSeekMessages } from '../client.js'

const VISION_MODEL = 'deepseek-v4-flash-vision-exp'
const PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const VISION_ROUTE = { providerId: 'deepseek', model: VISION_MODEL, chainIndex: 0 } as const

interface FakeClient {
	readonly chat: {
		readonly completions: {
			readonly create: ReturnType<typeof vi.fn>
		}
	}
	readonly models: { readonly list: ReturnType<typeof vi.fn> }
}

function stream(chunks: readonly unknown[]) {
	return {
		async *[Symbol.asyncIterator]() {
			for (const chunk of chunks) yield chunk
		},
	}
}

function providerWith(chunksByRequest: readonly (readonly unknown[])[] = [[]]): {
	readonly provider: DeepSeekProvider
	readonly requests: unknown[]
	readonly client: FakeClient
} {
	const requests: unknown[] = []
	let request = 0
	const client: FakeClient = {
		chat: {
			completions: {
				create: vi.fn(async (body: unknown) => {
					requests.push(structuredClone(body))
					return stream(chunksByRequest[request++] ?? [])
				}),
			},
		},
		models: { list: vi.fn(async () => ({ data: [] })) },
	}
	const provider = new DeepSeekProvider({ apiKey: 'sk-test', model: VISION_MODEL })
	;(provider as unknown as { client: FakeClient }).client = client
	return { provider, requests, client }
}

async function drainStream(
	provider: DeepSeekProvider,
	messages: Parameters<typeof toDeepSeekMessages>[0],
) {
	for await (const _chunk of provider.chatStream({ model: VISION_MODEL, messages })) {
		// The request body, not response aggregation, is the observer here.
	}
}

describe('DeepSeek image request projection', () => {
	it('sends user text and images through the real chatStream request hop', async () => {
		const { provider, requests } = providerWith([
			[
				{ id: 'done', choices: [{ delta: { content: 'ok' } }] },
				{ id: 'done', choices: [{ delta: {}, finish_reason: 'stop' }] },
			],
		])
		const messages = [
			{
				role: 'user' as const,
				content: 'Describe this pixel.',
				attachments: [{ type: 'image' as const, mediaType: 'image/png', data: PNG }],
			},
		]
		const original = structuredClone(messages)

		await drainStream(provider, messages)

		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({
			model: VISION_MODEL,
			messages: [
				{
					role: 'user',
					content: [
						{ type: 'text', text: 'Describe this pixel.' },
						{
							type: 'image_url',
							image_url: { url: `data:image/png;base64,${PNG}` },
						},
					],
				},
			],
		})
		expect(messages).toEqual(original)
	})

	it('keeps consecutive tool results in role:tool and follows them with one image message', () => {
		const messages = [
			{
				role: 'assistant' as const,
				content: '',
				toolCalls: [
					{ id: 'call_a', type: 'function' as const, function: { name: 'shot', arguments: '{}' } },
					{ id: 'call_b', type: 'function' as const, function: { name: 'shot', arguments: '{}' } },
				],
			},
			{
				role: 'tool' as const,
				toolCallId: 'call_a',
				content: [{ type: 'image' as const, mediaType: 'image/png', data: PNG }],
			},
			{
				role: 'tool' as const,
				toolCallId: 'call_b',
				content: [
					{ type: 'text' as const, text: 'second capture' },
					{ type: 'image' as const, mediaType: 'image/jpeg', data: 'c2Vjb25k' },
				],
			},
			{ role: 'user' as const, content: 'Compare them.' },
		]
		const original = structuredClone(messages)

		const wire = toDeepSeekMessages(messages, VISION_ROUTE)

		expect(wire.map((message) => message.role)).toEqual([
			'assistant',
			'tool',
			'tool',
			'user',
			'user',
		])
		expect(wire[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_a', content: '(no output)' })
		expect(wire[2]).toMatchObject({
			role: 'tool',
			tool_call_id: 'call_b',
			content: 'second capture',
		})
		expect(wire[3]).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'Attached image(s) from tool result:' },
				{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
				{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,c2Vjb25k' } },
			],
		})
		expect(messages).toEqual(original)
	})

	it.each([
		[
			'text model image',
			'deepseek-v4-flash',
			[
				{
					role: 'user' as const,
					content: 'look',
					attachments: [{ mediaType: 'image/png', data: PNG }],
				},
			],
			/does not accept image input/,
		],
		[
			'PDF',
			VISION_MODEL,
			[
				{
					role: 'user' as const,
					content: 'read',
					attachments: [
						{ type: 'document' as const, mediaType: 'application/pdf', data: 'JVBERi0x' },
					],
				},
			],
			/does not support document input/,
		],
		[
			'unresolved stored ref',
			VISION_MODEL,
			[
				{
					role: 'user' as const,
					content: 'look',
					attachments: [
						{
							type: 'stored' as const,
							ref: 'blob-1',
							kind: 'image' as const,
							mediaType: 'image/png',
						},
					],
				},
			],
			/unresolved stored attachment/,
		],
		[
			'unsupported image media type',
			VISION_MODEL,
			[
				{
					role: 'user' as const,
					content: 'look',
					attachments: [{ type: 'image' as const, mediaType: 'image/svg+xml', data: 'PHN2Zz4=' }],
				},
			],
			/image type 'image\/svg\+xml' is not supported/,
		],
		[
			'document tool result',
			VISION_MODEL,
			[
				{
					role: 'tool' as const,
					toolCallId: 'call_pdf',
					content: [
						{
							type: 'document' as const,
							mediaType: 'application/pdf',
							data: 'JVBERi0x',
							name: 'report.pdf',
						},
					],
				},
			],
			/does not support document tool results/,
		],
	] as const)('refuses %s before transport', async (_name, model, messages, expected) => {
		const { provider, client } = providerWith()
		await expect(
			(async () => {
				for await (const _chunk of provider.chatStream({
					model,
					messages: messages as unknown as Parameters<typeof toDeepSeekMessages>[0],
				})) {
					// no-op
				}
			})(),
		).rejects.toThrow(expected)
		expect(client.chat.completions.create).not.toHaveBeenCalled()
	})
})

describe('DeepSeek model metadata', () => {
	it('distinguishes known text, vision and unknown models', async () => {
		const { provider, client } = providerWith()
		client.models.list.mockResolvedValue({
			data: [{ id: 'deepseek-v4-flash' }, { id: 'private-gateway-model' }],
		})

		const models = await provider.listModels()

		expect(models.find((model) => model.id === 'deepseek-v4-flash')?.inputModalities).toEqual([
			'text',
		])
		expect(models.find((model) => model.id === VISION_MODEL)?.inputModalities).toEqual([
			'text',
			'image',
		])
		expect(models.find((model) => model.id === 'deepseek-v4-pro')?.inputModalities).toEqual([
			'text',
		])
		expect(models.find((model) => model.id === 'private-gateway-model')).not.toHaveProperty(
			'inputModalities',
		)
	})
})

describe('the query loop reaches tool-result images', () => {
	const dirs: string[] = []
	afterEach(async () => {
		const { rm } = await import('node:fs/promises')
		await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
	})

	it('puts the rich tool result on the second wire request without editing Run.messages', async () => {
		const { provider, requests } = providerWith([
			[
				{
					id: 'tool-turn',
					choices: [
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'call_capture',
										type: 'function',
										function: { name: 'capture', arguments: '{}' },
									},
								],
							},
						},
					],
				},
				{
					id: 'tool-turn',
					choices: [{ delta: {}, finish_reason: 'tool_calls' }],
				},
			],
			[
				{ id: 'answer', choices: [{ delta: { content: 'done' } }] },
				{ id: 'answer', choices: [{ delta: {}, finish_reason: 'stop' }] },
			],
		])
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'capture',
				description: 'Capture an image',
				inputSchema: MCPReconnectOptionsSchema,
				modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async () => ({
					success: true,
					output: 'captured',
					content: [
						{ type: 'text' as const, text: 'captured' },
						{ type: 'image' as const, mediaType: 'image/png', data: PNG },
					],
				}),
			}),
		)
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-deepseek-vision-'))
		dirs.push(cwd)

		const run = await drainQuery({
			provider,
			tools,
			agentId: 'deepseek-vision-agent',
			agentName: 'DeepSeek vision agent',
			messages: [{ role: 'user', content: 'capture one image' }],
			workingDirectory: cwd,
			runConfig: {
				model: VISION_MODEL,
				tokenBudget: 100_000,
				timeoutMs: 5_000,
				maxIterations: 2,
			},
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
		})

		expect(run.status).toBe('completed')
		expect(requests).toHaveLength(2)
		const second = requests[1] as { messages: Array<{ role: string; content: unknown }> }
		const toolAt = second.messages.findIndex((message) => message.role === 'tool')
		expect(second.messages[toolAt]).toMatchObject({ role: 'tool', content: 'captured' })
		expect(second.messages[toolAt + 1]).toEqual({
			role: 'user',
			content: [
				{ type: 'text', text: 'Attached image(s) from tool result:' },
				{ type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
			],
		})
		const durableTool = run.messages.find((message) => message.role === 'tool')
		expect(durableTool?.content).toEqual([
			{ type: 'text', text: 'captured' },
			{ type: 'image', mediaType: 'image/png', data: PNG },
		])
	})
})
