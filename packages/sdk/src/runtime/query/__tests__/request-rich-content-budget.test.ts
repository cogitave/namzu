import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { Message, ToolMessage, UserMessage } from '../../../types/message/index.js'
import type { AgentRunConfig } from '../../../types/run/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import {
	DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES,
	projectRequestRichContent,
} from '../request-rich-content.js'

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-rich-request-'))
	dirs.push(dir)
	return dir
}

async function run(opts: {
	provider: MockLLMProvider
	tools?: ToolRegistry
	messages: Message[]
	runConfig?: Partial<AgentRunConfig>
	pluginManager?: PluginLifecycleManager
}) {
	return drainQuery({
		provider: opts.provider,
		tools: opts.tools ?? new ToolRegistry(),
		agentId: 'rich_request_agent',
		agentName: 'Rich request agent',
		messages: opts.messages,
		workingDirectory: await workdir(),
		runConfig: {
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 4,
			...opts.runConfig,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
		...(opts.pluginManager ? { pluginManager: opts.pluginManager } : {}),
	})
}

describe('the request-only rich-content projection', () => {
	it('always withholds an image that the provider already rejected, even when budgeting is disabled', () => {
		const rejected = {
			role: 'user',
			content: 'look again',
			attachments: [
				{
					data: 'AAAA',
					mediaType: 'image/png',
					modelOmission: { reason: 'provider-rejected' },
				},
			],
		} as unknown as Message
		const messages = [rejected]
		const original = structuredClone(messages)

		const projected = projectRequestRichContent(messages, 0)

		expect(projected).not.toBe(messages)
		expect(projected).toEqual([
			expect.objectContaining({
				role: 'user',
				content: expect.stringContaining('provider rejected this image'),
			}),
		])
		expect((projected[0] as UserMessage).attachments).toBeUndefined()
		expect(messages).toEqual(original)
	})

	it('is allocation-free at the exact boundary and when explicitly disabled', () => {
		const messages: Message[] = [
			{
				role: 'user',
				content: 'look',
				attachments: [{ data: 'AAAA', mediaType: 'image/png' }],
			},
		]

		expect(projectRequestRichContent(messages, 4)).toBe(messages)
		expect(projectRequestRichContent(messages, 0)).toBe(messages)
	})

	it('does not let the budget conceal an unresolved stored attachment', () => {
		const messages: Message[] = [
			{
				role: 'user',
				content: 'look',
				attachments: [{ type: 'stored', ref: 'blob-1', kind: 'image', mediaType: 'image/png' }],
			},
		]

		expect(() => projectRequestRichContent(messages, 1)).toThrow(/unresolved stored attachment/)
	})
})

describe('one accumulated budget covers user and tool rich content', () => {
	it('omits the oldest tool image on the third real provider request without editing the run', async () => {
		const first = 'A'.repeat(8)
		const second = 'B'.repeat(8)
		const pending = [first, second]
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'capture',
				description: 'Capture an image',
				inputSchema: z.object({}),
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
						{
							type: 'image' as const,
							data: pending.shift() ?? '',
							mediaType: 'image/png',
						},
					],
				}),
			}),
		)
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'call_first', name: 'capture', args: {} }] },
				{ toolCalls: [{ id: 'call_second', name: 'capture', args: {} }] },
				{ text: 'done' },
			],
		})

		const settled = await run({
			provider,
			tools,
			messages: [{ role: 'user', content: 'capture twice' }],
			runConfig: { maxRequestRichContentBytes: 10 },
		})

		expect(provider.requests).toHaveLength(3)
		const sentTools = provider.requests[2]?.messages.filter(
			(message): message is ToolMessage => message.role === 'tool',
		)
		expect(sentTools?.map((message) => message.toolCallId)).toEqual(['call_first', 'call_second'])
		expect(sentTools?.[0]?.content).toEqual([
			{ type: 'text', text: 'captured' },
			expect.objectContaining({ type: 'text', text: expect.stringContaining('image omitted') }),
		])
		expect(sentTools?.[1]?.content).toEqual([
			{ type: 'text', text: 'captured' },
			{ type: 'image', data: second, mediaType: 'image/png' },
		])

		const canonicalTools = settled.messages.filter(
			(message): message is ToolMessage => message.role === 'tool',
		)
		expect(canonicalTools.map((message) => message.toolCallId)).toEqual([
			'call_first',
			'call_second',
		])
		expect(canonicalTools[0]?.content).toContainEqual({
			type: 'image',
			data: first,
			mediaType: 'image/png',
		})
		expect(canonicalTools[1]?.content).toContainEqual({
			type: 'image',
			data: second,
			mediaType: 'image/png',
		})
	})

	it('shares the same oldest-first budget across a user image and document', async () => {
		const image = { data: 'I'.repeat(6), mediaType: 'image/png' }
		const document = {
			type: 'document' as const,
			data: 'D'.repeat(6),
			mediaType: 'application/pdf',
			name: 'terms.pdf',
		}
		const messages: Message[] = [
			{ role: 'user', content: 'old image', attachments: [image] },
			{ role: 'assistant', content: 'noted' },
			{ role: 'user', content: 'new document', attachments: [document] },
		]
		const original = structuredClone(messages)
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const hookRequests: Message[][] = []
		const pluginManager = {
			executeHooks: async (event: string, context: { request?: { messages: Message[] } }) => {
				if (event === 'pre_llm_call' && context.request) {
					hookRequests.push(context.request.messages)
				}
				return []
			},
		} as unknown as PluginLifecycleManager

		const settled = await run({
			provider,
			messages,
			runConfig: { maxRequestRichContentBytes: 6 },
			pluginManager,
		})

		const sentUsers = provider.requests[0]?.messages.filter(
			(message): message is UserMessage => message.role === 'user',
		)
		expect(sentUsers?.[0]?.attachments).toBeUndefined()
		expect(sentUsers?.[0]?.content).toContain('image omitted')
		expect(sentUsers?.[1]?.attachments).toEqual([document])
		expect(hookRequests[0]).toEqual(provider.requests[0]?.messages)
		expect(messages).toEqual(original)
		expect(
			settled.messages.filter(
				(message) => message.role !== 'system' && message.role !== 'assistant',
			),
		).toEqual([original[0], original[2]])
	})

	it('uses the same projection on the separate limit-closing request', async () => {
		const image = { data: 'AAAA', mediaType: 'image/png' }
		const provider = new MockLLMProvider({ turns: [{ text: 'closing answer' }] })

		const settled = await run({
			provider,
			messages: [{ role: 'user', content: 'finish', attachments: [image] }],
			runConfig: { maxIterations: 0, maxRequestRichContentBytes: 1 },
		})

		expect(provider.requests).toHaveLength(1)
		const sent = provider.requests[0]?.messages.find(
			(message): message is UserMessage =>
				message.role === 'user' && message.content.startsWith('finish'),
		)
		expect(sent?.attachments).toBeUndefined()
		expect(sent?.content).toContain('image omitted')
		const canonical = settled.messages.find(
			(message): message is UserMessage => message.role === 'user' && message.content === 'finish',
		)
		expect(canonical?.attachments, 'the closing duplicate edited canonical history').toEqual([
			image,
		])
	})

	it('keeps the old unbounded behavior only when a caller explicitly selects zero', async () => {
		const image = { data: 'A'.repeat(32), mediaType: 'image/png' }
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })

		await run({
			provider,
			messages: [{ role: 'user', content: 'look', attachments: [image] }],
			runConfig: { maxRequestRichContentBytes: 0 },
		})

		const sent = provider.requests[0]?.messages.find(
			(message): message is UserMessage => message.role === 'user',
		)
		expect(sent?.attachments).toEqual([image])
	})
})

describe('the budget is resolved before a run can spend anything', () => {
	it('still refuses an unresolved stored reference before a provider call', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'must not run' }] })

		await expect(
			run({
				provider,
				messages: [
					{
						role: 'user',
						content: 'look',
						attachments: [{ type: 'stored', ref: 'blob-1', kind: 'image', mediaType: 'image/png' }],
					},
				],
				runConfig: { maxRequestRichContentBytes: 1 },
			}),
		).rejects.toThrow(/attachment store/i)
		expect(provider.requests).toHaveLength(0)
	})

	it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		'refuses invalid maxRequestRichContentBytes=%s before a provider call',
		async (maxRequestRichContentBytes) => {
			const provider = new MockLLMProvider({ turns: [{ text: 'must not run' }] })

			await expect(
				run({
					provider,
					messages: [{ role: 'user', content: 'go' }],
					runConfig: { maxRequestRichContentBytes },
				}),
			).rejects.toThrow(/maxRequestRichContentBytes must be a safe integer/)
			expect(provider.requests).toHaveLength(0)
		},
	)

	it('persists the effective default in the run evidence', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const settled = await run({ provider, messages: [{ role: 'user', content: 'go' }] })

		expect(settled.metadata.config.maxRequestRichContentBytes).toBe(
			DEFAULT_MAX_REQUEST_RICH_CONTENT_BYTES,
		)
	})
})
