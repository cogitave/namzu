import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
	PERMISSIVE_PROVIDER_CAPABILITIES,
	resolveProviderCapabilities,
} from '../../../provider/capabilities.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	LLMProvider,
	ProviderCapabilities,
	StreamChunk,
} from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
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
	readonly capabilities?: ProviderCapabilities
	lastParams?: ChatCompletionParams

	constructor(capabilities?: ProviderCapabilities) {
		this.capabilities = capabilities
	}

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.lastParams = params
		yield { id: 'msg_1', delta: { content: 'done' } }
		yield { id: 'msg_1', delta: {}, finishReason: 'stop', usage: ZERO_USAGE }
	}
}

class ClosingSummaryProvider implements LLMProvider {
	readonly id = 'closing-summary'
	readonly name = 'Closing Summary Provider'
	readonly calls: ChatCompletionParams[] = []

	async *chatStream(params: ChatCompletionParams): AsyncIterable<StreamChunk> {
		this.calls.push(params)
		if (this.calls.length === 1) {
			yield {
				id: 'msg_empty',
				delta: {},
				finishReason: 'stop',
				usage: ZERO_USAGE,
			}
			return
		}
		yield { id: 'msg_summary', delta: { content: 'closing summary' } }
		yield {
			id: 'msg_summary',
			delta: {},
			finishReason: 'stop',
			usage: ZERO_USAGE,
		}
	}
}

const NO_TOOLS_CAPABILITIES: ProviderCapabilities = {
	supportsTools: false,
	supportsStreaming: true,
	supportsFunctionCalling: false,
	supportsVision: true,
}

const NO_VISION_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: false,
}

function registerEchoTool(tools: ToolRegistry): void {
	tools.register({
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'ok' }),
	})
}

function registerEnforcedTool(tools: ToolRegistry, name: string): void {
	tools.register({
		name,
		description: `${name} tool`,
		inputSchema: z.object({
			new_string: z.string().optional(),
			newStr: z.string().optional(),
		}),
		modelInputSchema: {
			type: 'object',
			properties: { new_string: { type: 'string' } },
			required: ['new_string'],
			additionalProperties: false,
		},
		enforceModelInput: true,
		execute: async () => ({ success: true, output: 'ok' }),
	})
}

function baseParams(provider: LLMProvider, tools: ToolRegistry, workingDirectory: string) {
	return {
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
		workingDirectory,
		sessionId: 'ses_capability' as SessionId,
		threadId: 'thd_capability' as ThreadId,
		projectId: 'prj_capability' as ProjectId,
		tenantId: 'tnt_capability' as TenantId,
	}
}

describe('resolveProviderCapabilities', () => {
	it('resolves an undeclared provider to the permissive default', () => {
		expect(resolveProviderCapabilities(new CapturingProvider())).toEqual(
			PERMISSIVE_PROVIDER_CAPABILITIES,
		)
	})

	it('fills a partial declaration (missing supportsVision) permissively per field', () => {
		const resolved = resolveProviderCapabilities({
			capabilities: {
				supportsTools: false,
				supportsStreaming: true,
				supportsFunctionCalling: false,
			},
		})
		expect(resolved.supportsTools).toBe(false)
		expect(resolved.supportsVision).toBe(true)
	})
})

describe('query() capability negotiation', () => {
	let workdirs: string[] = []

	afterEach(async () => {
		await Promise.all(workdirs.map((dir) => rm(dir, { recursive: true, force: true })))
		workdirs = []
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-capability-'))
		workdirs.push(dir)
		return dir
	}

	it('strips tool surfaces and emits a capability_warning for a no-tools provider', async () => {
		const provider = new CapturingProvider(NO_TOOLS_CAPABILITIES)
		const tools = new ToolRegistry()
		registerEchoTool(tools)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...baseParams(provider, tools, await mkWorkdir()),
				messages: [createUserMessage('hello')],
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('completed')

		// The model was never told about tools: no tools param on the wire…
		expect(provider.lastParams?.tools).toBeUndefined()
		// …and no tool section in the system prompt.
		const systemPrompt = (provider.lastParams?.messages ?? [])
			.filter((m) => m.role === 'system')
			.map((m) => m.content)
			.join('\n')
		expect(systemPrompt).not.toContain('<available_tools>')
		expect(systemPrompt).not.toContain('echo')

		// The host got the machine-readable warning.
		const warning = events.find(
			(e): e is Extract<RunEvent, { type: 'capability_warning' }> =>
				e.type === 'capability_warning',
		)
		expect(warning?.capability).toBe('tools')
		expect(warning?.providerId).toBe('capturing')
		expect(warning?.message).toContain('stripped')
	})

	it('keeps tool surfaces intact for an undeclared (permissive-default) provider', async () => {
		const provider = new CapturingProvider()
		const tools = new ToolRegistry()
		registerEchoTool(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')
		expect(provider.lastParams?.tools?.map((t) => t.function.name)).toContain('echo')
	})

	it('propagates enforcement names from the exact allowed and cache-stable tool schemas', async () => {
		const provider = new CapturingProvider()
		const tools = new ToolRegistry()
		registerEnforcedTool(tools, 'edit')
		registerEnforcedTool(tools, 'cached_edit')
		registerEnforcedTool(tools, 'excluded_edit')
		tools.suspendAll()
		tools.activate(['edit'])

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			allowedTools: ['edit', 'cached_edit'],
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')
		expect(provider.lastParams?.tools?.map((tool) => tool.function.name)).toEqual([
			'edit',
			'cached_edit',
		])
		expect(provider.lastParams?.enforceToolInputSchema).toEqual(['edit', 'cached_edit'])
		expect(JSON.stringify(provider.lastParams?.tools)).not.toContain('newStr')
	})

	it('keeps the same enforcement hint on the closing-summary provider call', async () => {
		const provider = new ClosingSummaryProvider()
		const tools = new ToolRegistry()
		registerEnforcedTool(tools, 'edit')

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')
		expect(provider.calls).toHaveLength(2)
		for (const call of provider.calls) {
			expect(call.tools?.map((tool) => tool.function.name)).toEqual(['edit'])
			expect(call.enforceToolInputSchema).toEqual(['edit'])
		}
		expect(provider.calls[1]?.toolChoice).toBe('none')
	})

	it('emits a vision capability_warning when attachments hit a no-vision provider', async () => {
		const provider = new CapturingProvider(NO_VISION_CAPABILITIES)
		const events: RunEvent[] = []

		const run = await drainQuery(
			{
				...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
				messages: [
					createUserMessage('what is in this image?', [
						{ data: 'aGVsbG8=', mediaType: 'image/png' },
					]),
				],
			},
			(event) => {
				events.push(event)
			},
		)

		expect(run.status).toBe('completed')
		const warning = events.find(
			(e): e is Extract<RunEvent, { type: 'capability_warning' }> =>
				e.type === 'capability_warning',
		)
		expect(warning?.capability).toBe('vision')
		expect(warning?.providerId).toBe('capturing')
	})

	it('does not warn when no attachments are present on a no-vision provider', async () => {
		const provider = new CapturingProvider(NO_VISION_CAPABILITIES)
		const events: RunEvent[] = []

		await drainQuery(
			{
				...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
				messages: [createUserMessage('plain text')],
			},
			(event) => {
				events.push(event)
			},
		)

		expect(events.some((e) => e.type === 'capability_warning')).toBe(false)
	})

	it('strictCapabilities: true throws on a tools mismatch instead of degrading', async () => {
		const provider = new CapturingProvider(NO_TOOLS_CAPABILITIES)
		const tools = new ToolRegistry()
		registerEchoTool(tools)

		await expect(
			drainQuery({
				...baseParams(provider, tools, await mkWorkdir()),
				messages: [createUserMessage('hello')],
				strictCapabilities: true,
			}),
		).rejects.toThrow(/supportsTools: false/)
	})

	it('strictCapabilities: true throws on a vision mismatch instead of degrading', async () => {
		const provider = new CapturingProvider(NO_VISION_CAPABILITIES)

		await expect(
			drainQuery({
				...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
				messages: [createUserMessage('describe', [{ data: 'aGVsbG8=', mediaType: 'image/png' }])],
				strictCapabilities: true,
			}),
		).rejects.toThrow(/supportsVision: false/)
	})
})
