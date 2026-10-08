/**
 * An installed desktop host is a tool, not a line in `namzu doctor`.
 *
 * The CLI used to probe @namzu/computer-use and report it at boot, while the
 * production session registry never constructed the host or registered
 * `createComputerUseTool`. This drives the real `createAgentSession` front
 * door and observes the same registry a real query receives.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type LLMToolSchema, ToolManager, type Toolset } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

const desktop = vi.hoisted(() => ({
	failInitialize: false,
	windowMethods: true,
	windowDiscovery: true,
	initialize: vi.fn<() => Promise<void>>(),
	dispose: vi.fn<() => Promise<void>>(),
	execute: vi.fn(),
	getDisplayGeometry: vi.fn(),
}))

vi.mock('@namzu/computer-use', () => ({
	SubprocessComputerUseHost: class {
		readonly id = 'test-desktop'
		readonly capabilities = {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: true,
			windowCapture: true,
			windows: true,
		}

		async initialize() {
			await desktop.initialize()
			if (desktop.failInitialize) throw new Error('desktop bridge unavailable')
		}

		dispose = desktop.dispose
		execute = desktop.execute
		getDisplayGeometry = desktop.getDisplayGeometry
		captureWindow = desktop.windowMethods
			? async () => {
					throw new Error('not used')
				}
			: undefined
		executeWindow = desktop.windowMethods
			? async () => {
					throw new Error('not used')
				}
			: undefined
		listWindows = desktop.windowDiscovery ? async () => [] : undefined
		focusWindow = desktop.windowDiscovery
			? async (id: string) => ({ ok: true, focusedId: id })
			: undefined
	},
}))

vi.mock('@namzu/browser', () => ({
	PlaywrightBrowserHost: class {
		readonly id = 'test-browser'
		readonly profile: string
		readonly plan = { engine: 'windows-cdp', browser: 'chrome', warnings: [] }
		readonly warnings: string[] = []
		readonly running = false
		readonly capabilities = {
			engine: 'windows-cdp',
			headless: false,
			screenshot: true,
			upload: true,
		}
		constructor(options: { profile: string }) {
			this.profile = options.profile
		}
		async observe() {
			throw new Error('not used')
		}
		async act() {
			throw new Error('not used')
		}
		describeRef() {
			return undefined
		}
		session() {
			return { profile: this.profile }
		}
		async dispose() {}
	},
}))

let queryToolNames: readonly string[] = []
let queryTools: readonly LLMToolSchema[] = []
let enforcedToolNames: readonly string[] = []
let querySystemPrompt = ''
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { toolsets: readonly Toolset[]; systemPrompt?: string }) => {
			querySystemPrompt = params.systemPrompt ?? ''
			const manager = new ToolManager({ toolsets: params.toolsets, messages: () => [] })
			queryTools = manager.toLLMTools()
			queryToolNames = queryTools.map((tool) => tool.function.name)
			enforcedToolNames = manager
				.listNames()
				.map((name) => manager.get(name))
				.filter((tool): tool is NonNullable<typeof tool> => tool?.enforceModelInput === true)
				.map((tool) => tool.name)
			return (async function* () {})()
		},
	}
})

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gatewayForTurn: async () => ({}) as never,
		completionInboxForTurn: async () => new (await import('@namzu/sdk')).CompletionInbox(),
		releaseTurn: async () => {},
		agentTool: {
			name: 'Agent',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
			execute: async () => ({ success: true, output: '' }),
		},
		waitForTaskTool: {
			name: 'wait_for_task',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			modelInputSchema: { type: 'object', properties: {}, additionalProperties: false },
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
	}),
}))

let workDir = ''
const open: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-computer-use-'))
	queryToolNames = []
	queryTools = []
	enforcedToolNames = []
	querySystemPrompt = ''
	desktop.failInitialize = false
	desktop.windowMethods = true
	desktop.windowDiscovery = true
	desktop.initialize.mockReset().mockResolvedValue(undefined)
	desktop.dispose.mockReset().mockResolvedValue(undefined)
	desktop.execute.mockReset()
	desktop.getDisplayGeometry.mockReset()
})

afterEach(async () => {
	for (const session of open.splice(0)) await session.close()
	removeTempDir(workDir)
})

const prefs = {
	version: 3,
	providers: [{ id: 'anthropic' }],
	subagents: { active: [] },
} as Preferences

const detected = [
	{
		entry: {
			id: 'anthropic',
			label: 'Anthropic',
			defaultModel: 'claude-sonnet-4-5',
			requiresApiKey: true,
			envVars: ['ANTHROPIC_API_KEY'],
		},
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as unknown as DetectedProvider[]

const imagelessPrefs = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
} as Preferences

const imagelessDetected = [
	{
		entry: {
			id: 'openai',
			label: 'OpenAI',
			defaultModel: 'gpt-4o',
			requiresApiKey: true,
			envVars: ['OPENAI_API_KEY'],
		},
		source: { kind: 'env', envName: 'OPENAI_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as unknown as DetectedProvider[]

async function createSession(
	enableComputerUse = false,
	provider: 'anthropic' | 'openai' = 'anthropic',
	withBrowser = false,
) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(
		provider === 'openai' ? imagelessPrefs : prefs,
		provider === 'openai' ? imagelessDetected : detected,
		{
			cwd: workDir,
			enableComputerUse,
			...(withBrowser ? { browser: { profile: 'work', sites: { '*': 'ask' as const } } } : {}),
		},
	)
	open.push(session)
	return session
}

describe('computer use session reachability', () => {
	it('routes an existing Brave window to computer_use only when both tools are ready', async () => {
		const both = await createSession(true, 'anthropic', true)
		for await (const _ of both.send([{ role: 'user', content: 'my open Brave window' } as never])) {
			// drain into the mocked query boundary
		}
		expect(queryToolNames).toEqual(expect.arrayContaining(['browser', 'computer_use']))
		expect(querySystemPrompt).toContain('already open desktop browser window')
		expect(querySystemPrompt).toContain('separate Namzu-managed browser profile')

		querySystemPrompt = ''
		desktop.failInitialize = true
		const unavailable = await createSession(true, 'anthropic', true)
		for await (const _ of unavailable.send([
			{ role: 'user', content: 'my open Brave window' } as never,
		])) {
			// drain into the mocked query boundary
		}
		expect(querySystemPrompt).not.toContain('already open desktop browser window')

		querySystemPrompt = ''
		desktop.failInitialize = false
		desktop.windowMethods = true
		desktop.windowDiscovery = false
		const missingWindowDiscovery = await createSession(true, 'anthropic', true)
		for await (const _ of missingWindowDiscovery.send([
			{ role: 'user', content: 'my open Brave window' } as never,
		])) {
			// drain into the mocked query boundary
		}
		expect(querySystemPrompt).not.toContain('already open desktop browser window')

		querySystemPrompt = ''
		desktop.failInitialize = false
		desktop.windowMethods = false
		const missingWindowMethods = await createSession(true, 'anthropic', true)
		for await (const _ of missingWindowMethods.send([
			{ role: 'user', content: 'my open Brave window' } as never,
		])) {
			// drain into the mocked query boundary
		}
		expect(querySystemPrompt).not.toContain('already open desktop browser window')

		querySystemPrompt = ''
		const browserOnly = await createSession(false, 'anthropic', true)
		for await (const _ of browserOnly.send([
			{ role: 'user', content: 'my open Brave window' } as never,
		])) {
			// drain into the mocked query boundary
		}
		expect(querySystemPrompt).not.toContain('already open desktop browser window')
	})
	it('mounts the initialized host into the registry used by a real send and owns its cleanup', async () => {
		const session = await createSession(true)

		expect(desktop.initialize).toHaveBeenCalledTimes(1)
		expect(session.toolNames()).toContain('computer_use')
		expect(session.promptExemptTools()).not.toContain('computer_use')

		for await (const _ of session.send([{ role: 'user', content: 'see the desktop' } as never])) {
			// drain the real session adapter into the mocked kernel boundary
		}

		expect([...queryToolNames].sort()).toEqual(
			[
				'bash',
				'delete_memory',
				'edit',
				'glob',
				'grep',
				'job',
				'wait_for_job',
				'read',
				'write',
				'search_memory',
				'read_memory',
				'save_memory',
				'computer_use',
				'Agent',
				'update_memory',
				'wait_for_task',
				// The built-in skills are loaded through it.
				'skill',
				// The owner's Pals, mounted in every ordinary conversation.
				'list_pals',
				'send_pal_message',
			].sort(),
		)
		const computerUse = queryTools.find((t) => t.function.name === 'computer_use')?.function
			.parameters
		expect(computerUse).toMatchObject({
			type: 'object',
			required: ['type'],
			additionalProperties: false,
		})
		expect(computerUse).not.toHaveProperty('anyOf')
		expect(computerUse).not.toHaveProperty('oneOf')
		expect(computerUse).not.toHaveProperty('allOf')
		expect(enforcedToolNames).not.toContain('computer_use')
		await session.close()
		expect(desktop.dispose).toHaveBeenCalledTimes(1)
	})

	it('keeps an adapter that cannot initialize on the roster, unavailable, and says why to both', async () => {
		// The tool stays: a tool that is absent is one the model reasons about
		// from the wrong premise, while one that says "this desktop did not
		// answer, and why" is a result it reads once. The operator is told the
		// same thing in the notices.
		desktop.failInitialize = true
		const session = await createSession(true)

		// What the tool says about itself is the kernel's and pinned there
		// (`tools/builtins/__tests__/computer-use.test.ts`); this proves it is
		// on the roster at all.
		expect(session.toolNames()).toContain('computer_use')
		expect(session.configNotices).toContain(
			'Computer use is unavailable on this device: desktop bridge unavailable',
		)
		expect(desktop.dispose).toHaveBeenCalledTimes(1)
	})

	it('does not start the desktop for a provider that cannot show the model a screenshot', async () => {
		// This driver declares supportsToolResultImages: false, so every
		// screenshot would reach the model as a line of text.
		const session = await createSession(true, 'openai')

		expect(desktop.initialize).not.toHaveBeenCalled()
		expect(session.toolNames()).toContain('computer_use')
		expect(session.configNotices).toContain(
			'Computer use is unavailable in this session: The openai provider cannot return images in tool results, so the model would never see a screenshot. Use a provider that can (for example Anthropic, Codex or Google) for computer use.',
		)
		for await (const _ of session.send([{ role: 'user', content: 'see the desktop' } as never])) {
			// drain into the mocked kernel boundary
		}
		const computerUse = queryTools.find((t) => t.function.name === 'computer_use')?.function
		expect(computerUse?.description).toContain('cannot return images in tool results')
		expect(computerUse?.description).toContain('Do not retry; tell the user.')
		expect(desktop.execute).not.toHaveBeenCalled()
	})

	it('does not expose host input to a surface that did not claim an interactive permission owner', async () => {
		const session = await createSession()

		expect(desktop.initialize).not.toHaveBeenCalled()
		expect(session.toolNames()).not.toContain('computer_use')
	})
})
