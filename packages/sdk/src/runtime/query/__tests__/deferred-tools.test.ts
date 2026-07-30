import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { SearchToolsTool } from '../../../tools/builtins/search-tools.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { ProjectId, ThreadId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

const ZERO_USAGE = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
	cachedTokens: 0,
	cacheWriteTokens: 0,
}

class CapturingProvider implements LLMProvider {
	readonly id = 'capturing'
	readonly name = 'Capturing Provider'
	lastParams?: ChatCompletionParams

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.lastParams = params
		yield {
			id: 'msg_1',
			delta: { content: 'done' },
		}
		yield {
			id: 'msg_1',
			delta: {},
			finishReason: 'stop',
			usage: ZERO_USAGE,
		}
	}
}

class DeferredActivationProvider implements LLMProvider {
	readonly id = 'deferred-activation'
	readonly name = 'Deferred Activation Provider'
	readonly calls: ChatCompletionParams[] = []

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.calls.push(params)
		if (this.calls.length === 1) {
			yield {
				id: 'msg_search',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'toolu_search',
							type: 'function',
							function: { name: SearchToolsTool.name },
						},
					],
				},
			}
			yield {
				id: 'msg_search',
				delta: {
					toolCalls: [
						{
							index: 0,
							id: 'toolu_search',
							function: { arguments: '{"query":"canonical_key"}' },
						},
					],
				},
			}
			yield {
				id: 'msg_search',
				delta: {},
				finishReason: 'tool_calls',
				usage: ZERO_USAGE,
			}
			return
		}

		yield { id: 'msg_done', delta: { content: 'done' } }
		yield {
			id: 'msg_done',
			delta: {},
			finishReason: 'stop',
			usage: ZERO_USAGE,
		}
	}
}

function registerDeferredDocumentTool(tools: ToolRegistry, name = 'generate_document'): void {
	tools.register(
		{
			name,
			description: 'Generate a project document by document id.',
			inputSchema: z.object({
				documentId: z.string(),
			}),
			execute: async () => ({ success: true, output: 'generated' }),
		},
		'deferred',
	)
}

describe('query deferred tool discovery', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
		workdirs = []
	})

	it('auto-exposes search_tools when deferred tools are registered', async () => {
		const provider = new CapturingProvider()
		const tools = new ToolRegistry()
		registerDeferredDocumentTool(tools)

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-deferred-tools-'))
		workdirs.push(workingDirectory)

		const run = await drainQuery({
			provider,
			tools,
			runConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 1,
				maxResponseTokens: 256,
			},
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('what tools can you use?')],
			workingDirectory,
			sessionId: 'ses_deferred_tools' as SessionId,
			threadId: 'thd_deferred_tools' as ThreadId,
			projectId: 'prj_deferred_tools' as ProjectId,
			tenantId: 'tnt_deferred_tools' as TenantId,
		})

		expect(run.status).toBe('completed')
		expect(tools.has(SearchToolsTool.name)).toBe(true)
		expect(tools.getAvailability(SearchToolsTool.name)).toBe('active')
		expect(tools.getAvailability('generate_document')).toBe('deferred')

		const toolNames = provider.lastParams?.tools?.map((tool) => tool.function.name).sort() ?? []
		expect(toolNames).toEqual([SearchToolsTool.name])

		const systemPrompt = (provider.lastParams?.messages ?? [])
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.join('\n')
		expect(systemPrompt).toContain('Use search_tools to load these before use:')
		expect(systemPrompt).toContain('- generate_document')
		expect(systemPrompt).not.toContain(
			'Deferred tools are discoverable but not executable until the runtime activates them',
		)
	})

	it('keeps search_tools executable when allowedTools names a deferred tool', async () => {
		const provider = new CapturingProvider()
		const tools = new ToolRegistry()
		registerDeferredDocumentTool(tools)

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-deferred-tools-'))
		workdirs.push(workingDirectory)

		const run = await drainQuery({
			provider,
			tools,
			allowedTools: ['generate_document'],
			runConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 1,
				maxResponseTokens: 256,
			},
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('generate D-01')],
			workingDirectory,
			sessionId: 'ses_deferred_allowed_tools' as SessionId,
			threadId: 'thd_deferred_allowed_tools' as ThreadId,
			projectId: 'prj_deferred_allowed_tools' as ProjectId,
			tenantId: 'tnt_deferred_allowed_tools' as TenantId,
		})

		expect(run.status).toBe('completed')
		expect(tools.getAvailability('generate_document')).toBe('deferred')

		const toolNames = provider.lastParams?.tools?.map((tool) => tool.function.name).sort() ?? []
		expect(toolNames).toEqual([SearchToolsTool.name])

		const systemPrompt = (provider.lastParams?.messages ?? [])
			.filter((message) => message.role === 'system')
			.map((message) => message.content)
			.join('\n')
		expect(systemPrompt).toContain('Use search_tools to load these before use:')
		expect(systemPrompt).toContain('- generate_document')
	})

	it('adds enforcement only after a deferred model-schema tool is activated', async () => {
		const provider = new DeferredActivationProvider()
		const tools = new ToolRegistry()
		tools.register(
			{
				name: 'deferred_edit',
				description: 'Mutate a document using the provided content.',
				inputSchema: z.object({ legacyKey: z.string() }),
				modelInputSchema: {
					type: 'object',
					properties: { canonical_key: { type: 'string' } },
					required: ['canonical_key'],
					additionalProperties: false,
				},
				enforceModelInput: true,
				execute: async () => ({ success: true, output: 'edited' }),
			},
			'deferred',
		)

		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-deferred-enforcement-'))
		workdirs.push(workingDirectory)
		const run = await drainQuery({
			provider,
			tools,
			allowedTools: ['deferred_edit'],
			runConfig: {
				model: 'mock-model',
				timeoutMs: 5_000,
				tokenBudget: 100_000,
				maxIterations: 3,
				maxResponseTokens: 256,
			},
			agentId: 'agent_test',
			agentName: 'Test Agent',
			messages: [createUserMessage('find and load the right tool')],
			workingDirectory,
			sessionId: 'ses_deferred_enforcement' as SessionId,
			threadId: 'thd_deferred_enforcement' as ThreadId,
			projectId: 'prj_deferred_enforcement' as ProjectId,
			tenantId: 'tnt_deferred_enforcement' as TenantId,
		})

		expect(run.status).toBe('completed')
		expect(provider.calls).toHaveLength(2)
		expect(provider.calls[0]?.tools?.map((tool) => tool.function.name)).toEqual([
			SearchToolsTool.name,
		])
		expect(provider.calls[0]?.enforceToolInputSchema).toBeUndefined()
		expect(provider.calls[1]?.tools?.map((tool) => tool.function.name)).toEqual([
			'deferred_edit',
			SearchToolsTool.name,
		])
		expect(provider.calls[1]?.enforceToolInputSchema).toEqual(['deferred_edit'])
		expect(provider.calls[1]?.tools?.[0]?.function.parameters).toEqual(
			tools.get('deferred_edit')?.modelInputSchema,
		)
	})

	it('does not let search_tools reveal or activate deferred tools outside allowedTools', async () => {
		const tools = new ToolRegistry()
		registerDeferredDocumentTool(tools)
		registerDeferredDocumentTool(tools, 'dangerous_purge_document')

		// 'dangerous' matches only the out-of-allowlist tool ('delete'-style
		// CRUD verbs are stop tokens and never match anything by themselves).
		const result = await SearchToolsTool.execute(
			{ query: 'dangerous' },
			{
				runId: 'run_deferred_allowed_tools' as RunId,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => undefined,
				toolRegistry: tools,
				allowedTools: ['generate_document', SearchToolsTool.name],
			},
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('No deferred tools matching "dangerous"')
		expect(result.output).not.toContain('dangerous_purge_document')
		expect(tools.getAvailability('generate_document')).toBe('deferred')
		expect(tools.getAvailability('dangerous_purge_document')).toBe('deferred')
	})

	it('activates only the top-5 ranked matches and reports near-misses without activating', async () => {
		const tools = new ToolRegistry()
		// Eight deferred tools that all match "invoice" equally by name; the
		// alphabetical tie-break makes the top-5 cut deterministic.
		const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((s) => `invoice_${s}`)
		for (const name of names) {
			tools.register(
				{
					name,
					description: `Billing helper ${name.slice(-1)}.`,
					inputSchema: z.object({ id: z.string() }),
					execute: async () => ({ success: true, output: 'ok' }),
				},
				'deferred',
			)
		}

		const result = await SearchToolsTool.execute(
			{ query: 'invoice' },
			{
				runId: 'run_deferred_top_k' as RunId,
				workingDirectory: '/tmp',
				abortSignal: new AbortController().signal,
				env: {},
				log: () => undefined,
				toolRegistry: tools,
			},
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('Activated 5 tool(s)')
		expect(result.output).toContain('NOT loaded')
		expect(result.data).toMatchObject({
			activated: ['invoice_a', 'invoice_b', 'invoice_c', 'invoice_d', 'invoice_e'],
			count: 5,
			nearMisses: ['invoice_f', 'invoice_g', 'invoice_h'],
		})
		for (const name of ['invoice_a', 'invoice_b', 'invoice_c', 'invoice_d', 'invoice_e']) {
			expect(tools.getAvailability(name)).toBe('active')
		}
		for (const name of ['invoice_f', 'invoice_g', 'invoice_h']) {
			expect(tools.getAvailability(name)).toBe('deferred')
		}
	})
})
