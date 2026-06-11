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
