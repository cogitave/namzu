/**
 * The browser tools reach the interactive session, and only it.
 *
 * Drives the real `createAgentSession` with `@namzu/browser` replaced by a
 * stand-in host, and reads the registry a real query receives: the tools are
 * there when the TUI asks for them, nothing launches at boot, a profile
 * switch builds the next host and disposes the last, closing the session
 * disposes it, and a session that did not ask (exec, drain, acp) has no
 * browser at all.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type LLMToolSchema, ToolManager, type Toolset } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

const browser = vi.hoisted(() => ({
	built: [] as Record<string, unknown>[],
	disposed: [] as string[],
	observed: [] as unknown[],
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
		constructor(options: Record<string, unknown>) {
			browser.built.push(options)
			this.profile = String(options.profile)
		}
		async observe(action: unknown) {
			browser.observed.push(action)
			return {
				page: { origin: 'https://example.com', url: 'https://example.com/', title: 'x', tab: 't1' },
			}
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
		async dispose() {
			browser.disposed.push(this.profile)
		}
	},
}))

let queryToolNames: readonly string[] = []
let queryTools: readonly LLMToolSchema[] = []
let enforcedToolNames: readonly string[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { toolsets: readonly Toolset[] }) => {
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
	workDir = mkdtempSync(join(tmpdir(), 'namzu-browser-session-'))
	queryToolNames = []
	queryTools = []
	enforcedToolNames = []
	browser.built.length = 0
	browser.disposed.length = 0
	browser.observed.length = 0
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

async function createSession(withBrowser: boolean) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detected, {
		cwd: workDir,
		...(withBrowser
			? {
					browser: {
						profile: 'work',
						sites: { 'https://example.com': 'act', '*': 'ask' } as const,
					},
				}
			: {}),
	})
	open.push(session)
	return session
}

describe('browser session reachability', () => {
	it('mounts both tools for a surface that asks, and launches nothing at boot', async () => {
		const session = await createSession(true)

		expect(session.toolNames()).toEqual(expect.arrayContaining(['browser', 'browser_act']))
		expect(browser.built).toEqual([
			expect.objectContaining({
				profile: 'work',
				mode: 'interactive',
				sites: { 'https://example.com': 'act', '*': 'ask' },
			}),
		])
		expect(browser.observed).toEqual([])
		expect(session.browser?.status()).toMatchObject({
			profile: 'work',
			engine: 'windows-cdp',
			headless: false,
			running: false,
		})

		for await (const _ of session.send([{ role: 'user', content: 'browse' } as never])) {
			// drain into the mocked kernel boundary
		}
		expect(queryToolNames).toEqual(expect.arrayContaining(['browser', 'browser_act']))
		// Flat provider schemas, like computer_use.
		const schema = queryTools.find((t) => t.function.name === 'browser_act')?.function.parameters
		expect(schema).not.toHaveProperty('anyOf')
	})

	it('switches profile by disposing the old host and building the next, and disposes on close', async () => {
		const session = await createSession(true)
		const status = await session.browser?.switchProfile('personal')
		expect(status?.profile).toBe('personal')
		expect(browser.disposed).toEqual(['work'])
		expect(browser.built.map((options) => options.profile)).toEqual(['work', 'personal'])
		await expect(session.browser?.switchProfile('Not A Name')).rejects.toThrow(/not a profile name/)
		await session.close()
		expect(browser.disposed).toEqual(['work', 'personal'])
	})

	it('gives a session that did not ask no browser', async () => {
		const session = await createSession(false)
		expect(session.toolNames()).not.toContain('browser')
		expect(session.toolNames()).not.toContain('browser_act')
		expect(session.browser).toBeUndefined()
		expect(browser.built).toEqual([])
	})
})

describe('headless surfaces never ask for the browser', () => {
	// exec, exec --json, drain, acp and the resident step build their own
	// session options. None of them may name the browser: a signed-in
	// browser with nobody at the window is exactly what they must not get.
	it.each([
		'../../commands/exec.ts',
		'../../commands/exec-json.ts',
		'../../commands/drain.ts',
		'../../commands/acp.ts',
		'../../integrations/resident/session-step.ts',
	])('%s passes no browser option', (file) => {
		const text = readFileSync(new URL(file, import.meta.url), 'utf8')
		expect(text).not.toMatch(/\bbrowser\s*:/)
		expect(text).not.toMatch(/createBrowserControl|createBrowserTools/)
	})

	it('the TUI does', () => {
		const text = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
		expect(text).toMatch(/\bbrowser:\s*browserOptions/)
	})
})
