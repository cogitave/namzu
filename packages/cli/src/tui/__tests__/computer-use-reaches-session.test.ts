/**
 * An installed desktop host is a tool, not a line in `namzu doctor`.
 *
 * The CLI used to probe @namzu/computer-use and report it at boot, while the
 * production session registry never constructed the host or registered
 * `createComputerUseTool`. This drives the real `createAgentSession` front
 * door and observes the same registry a real query receives.
 */

import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	type LLMProvider,
	type LLMToolSchema,
	MockLLMProvider,
	ProviderRegistry,
	ToolManager,
	type Toolset,
} from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

const desktop = vi.hoisted(() => ({
	failInitialize: false,
	noControl: false,
	browserUnavailableReason: undefined as string | undefined,
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
		get capabilities() {
			const on = !desktop.noControl
			return {
				displayServer: 'win32' as const,
				screenshot: on,
				mouse: on,
				keyboard: on,
				cursorPosition: on,
				clipboard: on,
				windowCapture: on,
				windows: on,
			}
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
		get capabilities() {
			return {
				engine: 'windows-cdp',
				headless: false,
				screenshot: true,
				upload: true,
				...(desktop.browserUnavailableReason !== undefined
					? { unavailableReason: desktop.browserUnavailableReason }
					: {}),
			}
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

// What `model: auto` routes the next turn to. Absent: the session's own model.
const route = vi.hoisted(() => ({
	target: undefined as { provider: string; model: string } | undefined,
}))

vi.mock('../../integrations/decision/routing.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/decision/routing.js')>()
	return {
		...actual,
		routeModel: async (input: { config: { default: { provider: string; model: string } } }) => {
			const target = route.target ?? input.config.default
			return { tier: 'default', ...target, confidence: 1, reason: 'test' }
		},
	}
})

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
	desktop.noControl = false
	desktop.browserUnavailableReason = undefined
	desktop.windowMethods = true
	desktop.windowDiscovery = true
	desktop.initialize.mockReset().mockResolvedValue(undefined)
	desktop.dispose.mockReset().mockResolvedValue(undefined)
	desktop.execute.mockReset()
	desktop.getDisplayGeometry.mockReset()
	route.target = undefined
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
	it('routes an existing browser window to computer_use only when both tools are ready', async () => {
		const both = await createSession(true, 'anthropic', true)
		for await (const _ of both.send([
			{ role: 'user', content: 'my open browser window' } as never,
		])) {
			// drain into the mocked query boundary
		}
		expect(queryToolNames).toEqual(expect.arrayContaining(['browser', 'computer_use']))
		expect(querySystemPrompt).toContain('already open desktop browser window')
		expect(querySystemPrompt).toContain('separate Namzu-managed browser profile')

		querySystemPrompt = ''
		desktop.failInitialize = true
		const unavailable = await createSession(true, 'anthropic', true)
		for await (const _ of unavailable.send([
			{ role: 'user', content: 'my open browser window' } as never,
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
			{ role: 'user', content: 'my open browser window' } as never,
		])) {
			// drain into the mocked query boundary
		}
		expect(querySystemPrompt).not.toContain('already open desktop browser window')

		querySystemPrompt = ''
		desktop.failInitialize = false
		desktop.windowMethods = false
		const missingWindowMethods = await createSession(true, 'anthropic', true)
		for await (const _ of missingWindowMethods.send([
			{ role: 'user', content: 'my open browser window' } as never,
		])) {
			// drain into the mocked query boundary
		}
		expect(querySystemPrompt).not.toContain('already open desktop browser window')

		querySystemPrompt = ''
		const browserOnly = await createSession(false, 'anthropic', true)
		for await (const _ of browserOnly.send([
			{ role: 'user', content: 'my open browser window' } as never,
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
				'web_fetch',
				// The built-in skills are loaded through it.
				'skill',
				// The Pal tools are mounted but not sent: this owner has no Pals
				// (see the Pal case below).
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

	it('keeps an adapter that cannot initialize on the roster, out of the request, and says why to the operator', async () => {
		// The roster still names it (so `/tools` and the notices can say what
		// happened), but a tool that can only refuse is not sent to the model:
		// its schema is ~900 tokens on every request.
		desktop.failInitialize = true
		const session = await createSession(true)

		// What the tool says about itself is the kernel's and pinned there
		// (`tools/builtins/__tests__/computer-use.test.ts`); this proves it is
		// on the roster at all.
		expect(session.toolNames()).toContain('computer_use')
		expect(session.configNotices).toContain(
			'Computer use is unavailable on this device. Run with --debug for details.',
		)
		for await (const _ of session.send([{ role: 'user', content: 'see the desktop' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).not.toContain('computer_use')
		expect(desktop.dispose).toHaveBeenCalledTimes(1)
	})

	it('does not start the desktop for a provider that cannot show the model a screenshot', async () => {
		// This driver declares supportsToolResultImages: false, so every
		// screenshot would reach the model as a line of text.
		const session = await createSession(true, 'openai')

		expect(desktop.initialize).not.toHaveBeenCalled()
		expect(session.toolNames()).toContain('computer_use')
		// Not announced at the top of every session: the reason travels with the tool, below.
		expect(session.configNotices.join('\n')).not.toContain('Computer use is unavailable')
		for await (const _ of session.send([{ role: 'user', content: 'see the desktop' } as never])) {
			// drain into the mocked kernel boundary
		}
		// Every call would be refused, so the request does not carry the schema.
		expect(queryToolNames).not.toContain('computer_use')
		expect(desktop.execute).not.toHaveBeenCalled()
	})

	it('sends computer_use only while the host reports a control, and names it again once it does', async () => {
		desktop.noControl = true
		const session = await createSession(true)
		expect(session.toolNames()).toContain('computer_use')
		for await (const _ of session.send([{ role: 'user', content: 'a' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).not.toContain('computer_use')

		desktop.noControl = false
		for await (const _ of session.send([{ role: 'user', content: 'b' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).toContain('computer_use')
	})

	it('brings computer_use back when a turn moves from a text-only model to one that reads images', async () => {
		// One driver, two models: the catalogue says `text-only-model` cannot read
		// an image. The session starts on it, and Auto routes a later turn to a
		// model that can.
		const create = vi.spyOn(ProviderRegistry, 'create').mockImplementation(() => {
			const provider: LLMProvider = Object.assign(new MockLLMProvider(), {
				supportsImageInputFor: (model: string) => model !== 'text-only-model',
			})
			return { provider, capabilities: {} } as never
		})
		try {
			const { createAgentSession } = await import('../agent.js')
			const session = await createAgentSession(
				{ ...prefs, providers: [{ id: 'anthropic', model: 'text-only-model' }] } as Preferences,
				detected,
				{
					cwd: workDir,
					enableComputerUse: true,
					routing: { default: { provider: 'anthropic', model: 'text-only-model' } },
				},
			)
			open.push(session)
			// Under Auto the turn's model is not known when a picture is attached, so
			// the session's own text-only model does not refuse it.
			expect(session.imageAttachmentsSupported).not.toBe(false)

			for await (const _ of session.send([{ role: 'user', content: 'a' } as never])) {
				// drain into the mocked kernel boundary
			}
			// The model would act on screenshots it never saw.
			expect(queryToolNames).not.toContain('computer_use')

			route.target = { provider: 'anthropic', model: 'vision-model' }
			for await (const _ of session.send([{ role: 'user', content: 'b' } as never])) {
				// drain into the mocked kernel boundary
			}
			expect(queryToolNames).toContain('computer_use')

			route.target = undefined
			for await (const _ of session.send([{ role: 'user', content: 'c' } as never])) {
				// drain into the mocked kernel boundary
			}
			expect(queryToolNames).not.toContain('computer_use')

			// Without Auto the session's model is the one that reads the picture.
			const pinned = await createAgentSession(
				{ ...prefs, providers: [{ id: 'anthropic', model: 'text-only-model' }] } as Preferences,
				detected,
				{ cwd: workDir },
			)
			open.push(pinned)
			expect(pinned.imageAttachmentsSupported).toBe(false)
		} finally {
			create.mockRestore()
		}
	})

	it('sends the browser tools only while the browser has a usable engine', async () => {
		desktop.browserUnavailableReason = 'no display for a visible window'
		const session = await createSession(false, 'anthropic', true)
		expect(session.toolNames()).toEqual(expect.arrayContaining(['browser', 'browser_act']))
		for await (const _ of session.send([{ role: 'user', content: 'a' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).not.toContain('browser')
		expect(queryToolNames).not.toContain('browser_act')

		desktop.browserUnavailableReason = undefined
		for await (const _ of session.send([{ role: 'user', content: 'b' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).toEqual(expect.arrayContaining(['browser', 'browser_act']))
	})

	it('sends the Pal tools only once the owner has a Pals registry', async () => {
		const { createAgentSession } = await import('../agent.js')
		const stateRoot = join(workDir, 'state')
		mkdirSync(stateRoot, { recursive: true })
		const session = await createAgentSession(prefs, detected, { cwd: workDir, stateRoot })
		open.push(session)
		for await (const _ of session.send([{ role: 'user', content: 'a' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).not.toContain('list_pals')
		expect(queryToolNames).not.toContain('send_pal_message')

		mkdirSync(join(stateRoot, 'pals'))
		for await (const _ of session.send([{ role: 'user', content: 'b' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).toEqual(expect.arrayContaining(['list_pals', 'send_pal_message']))
	})

	it('does not expose host input to a surface that did not claim an interactive permission owner', async () => {
		const session = await createSession()

		expect(desktop.initialize).not.toHaveBeenCalled()
		expect(session.toolNames()).not.toContain('computer_use')
	})
})

describe('decision tool reachability', () => {
	it('mounts `decide` when a decision provider is configured, and omits it otherwise', async () => {
		const { createAgentSession } = await import('../agent.js')
		const withDecision = await createAgentSession(prefs, detected, {
			cwd: workDir,
			decision: {
				provider: 'azure',
				endpoint: 'https://res.services.ai.azure.com',
				deployment: 'decision-1',
			},
		})
		open.push(withDecision)
		expect(withDecision.toolNames()).toContain('decide')

		const without = await createSession()
		expect(without.toolNames()).not.toContain('decide')
	})
})
