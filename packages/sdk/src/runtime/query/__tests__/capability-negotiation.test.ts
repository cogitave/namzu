import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import {
	PERMISSIVE_PROVIDER_CAPABILITIES,
	resolveProviderCapabilities,
} from '../../../provider/capabilities.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { LLMProvider, ProviderCapabilities } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

/**
 * The scriptable mock captures every request and now accepts a capability
 * override, which is the whole reason this suite had a bespoke class: a
 * fixed registry-level declaration cannot express "a driver with no
 * vision".
 */
function capturingProvider(capabilities?: ProviderCapabilities): MockLLMProvider {
	return new MockLLMProvider({
		turns: [{ text: 'done' }],
		...(capabilities ? { capabilities } : {}),
	})
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

const NO_TOOL_IMAGE_CAPABILITIES: ProviderCapabilities = {
	supportsTools: true,
	supportsStreaming: true,
	supportsFunctionCalling: true,
	supportsVision: true,
	supportsDocuments: true,
	supportsToolResultImages: false,
	supportsToolResultDocuments: false,
}

const PNG_1X1 =
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

/**
 * A tool that opts in to constrained generation, which is the only thing
 * that makes `enforceToolInputSchema` non-empty on the wire.
 */
function registerEnforcedTool(tools: ToolRegistry, name: string): void {
	tools.register({
		name,
		description: `${name} tool`,
		inputSchema: z.object({ new_string: z.string().optional(), newStr: z.string().optional() }),
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

function registerEchoTool(tools: ToolRegistry): void {
	tools.register({
		name: 'echo',
		description: 'Echo the text back.',
		inputSchema: z.object({ text: z.string() }),
		execute: async () => ({ success: true, output: 'ok' }),
	})
}

function registerScreenshotTool(tools: ToolRegistry): void {
	tools.register({
		name: 'shot',
		description: 'Capture one image.',
		inputSchema: z.object({}),
		isReadOnly: () => true,
		execute: async () => ({
			success: true,
			output: 'captured',
			content: [{ type: 'image' as const, data: PNG_1X1, mediaType: 'image/png' }],
		}),
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
		topicId: 'top_capability' as TopicId,
		projectId: 'prj_capability' as ProjectId,
		tenantId: 'tnt_capability' as TenantId,
	}
}

describe('resolveProviderCapabilities', () => {
	it('resolves an undeclared provider to the permissive default', () => {
		expect(resolveProviderCapabilities(capturingProvider())).toEqual(
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
		await removeTempDirs(workdirs)
		workdirs = []
	})

	async function mkWorkdir(): Promise<string> {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-capability-'))
		workdirs.push(dir)
		return dir
	}

	it('strips tool surfaces and emits a capability_warning for a no-tools provider', async () => {
		const provider = capturingProvider(NO_TOOLS_CAPABILITIES)
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
		expect(provider.requests.at(-1)?.tools).toBeUndefined()
		// …and no tool section in the system prompt.
		const systemPrompt = (provider.requests.at(-1)?.messages ?? [])
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
		expect(warning?.providerId).toBe(provider.id)
		expect(warning?.message).toContain('stripped')
	})

	it('keeps tool surfaces intact for an undeclared (permissive-default) provider', async () => {
		const provider = capturingProvider()
		const tools = new ToolRegistry()
		registerEchoTool(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')
		expect(provider.requests.at(-1)?.tools?.map((t) => t.function.name)).toContain('echo')
	})

	it('emits a vision capability_warning when attachments hit a no-vision provider', async () => {
		const provider = capturingProvider(NO_VISION_CAPABILITIES)
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
		expect(warning?.providerId).toBe(provider.id)
	})

	it('does not warn when no attachments are present on a no-vision provider', async () => {
		const provider = capturingProvider(NO_VISION_CAPABILITIES)
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

	it('warns before the request that first carries an unsupported tool image, once', async () => {
		const order: string[] = []
		let request = 0
		const provider = new MockLLMProvider({
			capabilities: NO_TOOL_IMAGE_CAPABILITIES,
			turns: [
				{ toolCalls: [{ id: 'call_shot', name: 'shot', args: {} }] },
				{ toolCalls: [{ id: 'call_echo', name: 'echo', args: { text: 'continue' } }] },
				{ text: 'done' },
			],
			onRequest: () => order.push(`request-${++request}`),
		})
		const tools = new ToolRegistry()
		registerScreenshotTool(tools)
		registerEchoTool(tools)
		const events: RunEvent[] = []

		const base = baseParams(provider, tools, await mkWorkdir())
		const run = await drainQuery(
			{
				...base,
				runConfig: { ...base.runConfig, maxIterations: 3 },
				messages: [createUserMessage('inspect the screen')],
			},
			(event) => {
				events.push(event)
				if (
					event.type === 'capability_warning' &&
					event.capability === 'vision' &&
					event.contentSource === 'tool-result'
				) {
					order.push('warning')
				}
			},
		)

		expect(run.status).toBe('completed')
		expect(provider.requests).toHaveLength(3)
		expect(order).toEqual(['request-1', 'warning', 'request-2', 'request-3'])
		expect(
			events.filter(
				(event) =>
					event.type === 'capability_warning' &&
					event.capability === 'vision' &&
					event.contentSource === 'tool-result',
			),
		).toHaveLength(1)
	})

	it('does not warn for supported, textual, or already-budgeted tool results', async () => {
		const cases = [
			{
				name: 'supported image',
				capabilities: { ...NO_TOOL_IMAGE_CAPABILITIES, supportsToolResultImages: true },
				register: registerScreenshotTool,
				maxRequestRichContentBytes: undefined,
			},
			{
				name: 'plain text',
				capabilities: NO_TOOL_IMAGE_CAPABILITIES,
				register: registerEchoTool,
				maxRequestRichContentBytes: undefined,
			},
			{
				name: 'budgeted image',
				capabilities: NO_TOOL_IMAGE_CAPABILITIES,
				register: registerScreenshotTool,
				maxRequestRichContentBytes: 1,
			},
		] as const

		for (const testCase of cases) {
			const toolName = testCase.register === registerEchoTool ? 'echo' : 'shot'
			const args = toolName === 'echo' ? { text: 'hello' } : {}
			const provider = new MockLLMProvider({
				capabilities: testCase.capabilities,
				turns: [{ toolCalls: [{ name: toolName, args }] }, { text: 'done' }],
			})
			const tools = new ToolRegistry()
			testCase.register(tools)
			const events: RunEvent[] = []
			const base = baseParams(provider, tools, await mkWorkdir())
			await drainQuery(
				{
					...base,
					runConfig: {
						...base.runConfig,
						maxIterations: 2,
						...(testCase.maxRequestRichContentBytes !== undefined
							? { maxRequestRichContentBytes: testCase.maxRequestRichContentBytes }
							: {}),
					},
					messages: [createUserMessage(testCase.name)],
				},
				(event) => {
					events.push(event)
				},
			)

			expect(
				events.some(
					(event) =>
						event.type === 'capability_warning' &&
						event.capability === 'vision' &&
						event.contentSource === 'tool-result',
				),
				testCase.name,
			).toBe(false)
		}
	})

	it('strict capability mode refuses before a second request can carry a tool image', async () => {
		const provider = new MockLLMProvider({
			capabilities: NO_TOOL_IMAGE_CAPABILITIES,
			turns: [{ toolCalls: [{ name: 'shot', args: {} }] }, { text: 'must not run' }],
		})
		const tools = new ToolRegistry()
		registerScreenshotTool(tools)
		const base = baseParams(provider, tools, await mkWorkdir())

		const run = await drainQuery({
			...base,
			runConfig: { ...base.runConfig, maxIterations: 2 },
			messages: [createUserMessage('inspect')],
			strictCapabilities: true,
		})
		expect(run.status).toBe('failed')
		expect(run.lastError).toMatch(/cannot map image tool results/)
		expect(provider.requests).toHaveLength(1)
	})

	it('strictCapabilities: true throws on a tools mismatch instead of degrading', async () => {
		const provider = capturingProvider(NO_TOOLS_CAPABILITIES)
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
		const provider = capturingProvider(NO_VISION_CAPABILITIES)

		await expect(
			drainQuery({
				...baseParams(provider, new ToolRegistry(), await mkWorkdir()),
				messages: [createUserMessage('describe', [{ data: 'aGVsbG8=', mediaType: 'image/png' }])],
				strictCapabilities: true,
			}),
		).rejects.toThrow(/supportsVision: false/)
	})

	it('names the enforced tools on the request, so a driver can constrain them', async () => {
		const provider = capturingProvider()
		const tools = new ToolRegistry()
		registerEnforcedTool(tools, 'edit')
		registerEnforcedTool(tools, 'write')
		registerEchoTool(tools)

		const run = await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		expect(run.status).toBe('completed')
		// The producer was deleted, so this was undefined on every request and
		// the three drivers that read it were reading a field nothing ever
		// set — `enforceModelInput` on a tool meant nothing end to end.
		expect(provider.requests.at(-1)?.enforceToolInputSchema).toEqual(['edit', 'write'])
	})

	it('omits the field entirely when no tool opts in', async () => {
		const provider = capturingProvider()
		const tools = new ToolRegistry()
		registerEchoTool(tools)

		await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			messages: [createUserMessage('hello')],
		})

		// An empty array would read as "enforce nothing" rather than "nothing
		// asked", and a driver cannot tell those two apart.
		expect(provider.requests.at(-1)?.enforceToolInputSchema).toBeUndefined()
	})

	it('follows the allowed set rather than everything registered', async () => {
		const provider = capturingProvider()
		const tools = new ToolRegistry()
		registerEnforcedTool(tools, 'edit')
		registerEnforcedTool(tools, 'excluded')

		await drainQuery({
			...baseParams(provider, tools, await mkWorkdir()),
			allowedTools: ['edit'],
			messages: [createUserMessage('hello')],
		})

		expect(provider.requests.at(-1)?.enforceToolInputSchema).toEqual(['edit'])
	})
})
