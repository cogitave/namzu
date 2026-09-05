import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { SearchToolsTool } from '../../../tools/builtins/search-tools.js'
import type { RunId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The scriptable mock captures every request it receives, which is all
 * this suite ever needed a hand-rolled provider for. Keeping a bespoke
 * class here would mean re-implementing the frame sequence by hand — the
 * exact duplication the mock was rebuilt to remove.
 */
function capturingProvider(): MockLLMProvider {
	return new MockLLMProvider({ turns: [{ text: 'done' }] })
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
		await removeTempDirs(workdirs)
		workdirs = []
	})

	it('auto-exposes search_tools when deferred tools are registered', async () => {
		const provider = capturingProvider()
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
			sessionId: '5df50119-0604-4efb-9ce9-ec54a635b257' as SessionId,
			topicId: '2d636b87-b749-4b32-9f0b-5cc6dec1cd13' as TopicId,
			projectId: 'f8135875-706b-426d-8012-26fccc63ec88' as ProjectId,
			tenantId: '89016fd9-b650-4aea-9ce4-a7c85ccb789d' as TenantId,
		})

		expect(run.status).toBe('completed')
		expect(tools.has(SearchToolsTool.name)).toBe(true)
		expect(tools.getAvailability(SearchToolsTool.name)).toBe('active')
		expect(tools.getAvailability('generate_document')).toBe('deferred')

		const toolNames =
			provider.requests
				.at(-1)
				?.tools?.map((tool) => tool.function.name)
				.sort() ?? []
		expect(toolNames).toEqual([SearchToolsTool.name])

		const systemPrompt = (provider.requests.at(-1)?.messages ?? [])
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
		const provider = capturingProvider()
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
			sessionId: '71a8c074-a07e-43f4-9419-dbc08308ed4c' as SessionId,
			topicId: 'c8643bd3-566a-4be9-adda-35b70a7eb33f' as TopicId,
			projectId: '8870b8ec-4121-46ec-96b1-ae159780fa26' as ProjectId,
			tenantId: 'd4401c55-891e-46c1-935d-9c47708a5ffe' as TenantId,
		})

		expect(run.status).toBe('completed')
		expect(tools.getAvailability('generate_document')).toBe('deferred')

		const toolNames =
			provider.requests
				.at(-1)
				?.tools?.map((tool) => tool.function.name)
				.sort() ?? []
		expect(toolNames).toEqual([SearchToolsTool.name])

		const systemPrompt = (provider.requests.at(-1)?.messages ?? [])
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
				runId: '3be09a61-8dda-40c4-b92e-7557b0abd9ad' as RunId,
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
				runId: '38f6525d-0bbb-45cb-9f48-710f6a4a3898' as RunId,
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
