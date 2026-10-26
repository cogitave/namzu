/**
 * Model-facing text names a category, never a consumer product as an example.
 *
 * A concrete example in a prompt or a tool description leaks into answers as a
 * fact or a preference ("I used it because my guidelines mention it") and
 * biases tool choice. This assembles what a real session hands the model (the
 * system prompt and every mounted tool's description and parameter schema) and
 * the skill documents the model is given, then fails on a known list of
 * consumer product and brand names.
 *
 * Real identifiers the code needs (tool names, commands, protocols, file
 * formats) are not on the list. A name that is genuinely needed goes on
 * ALLOWED, with the reason beside it.
 */

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type LLMToolSchema, ToolManager, type Toolset } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

vi.mock('@namzu/computer-use', () => ({
	SubprocessComputerUseHost: class {
		readonly id = 'test-desktop'
		get capabilities() {
			return {
				displayServer: 'win32' as const,
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: true,
				clipboard: true,
				windowCapture: true,
				windows: true,
			}
		}
		async initialize() {}
		async dispose() {}
		async execute() {}
		async getDisplayGeometry() {}
		captureWindow = async () => {
			throw new Error('not used')
		}
		executeWindow = async () => {
			throw new Error('not used')
		}
		listWindows = async () => []
		focusWindow = async (id: string) => ({ ok: true, focusedId: id })
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
			return { engine: 'windows-cdp', headless: false, screenshot: true, upload: true }
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

let queryTools: readonly LLMToolSchema[] = []
let querySystemPrompt = ''
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { toolsets: readonly Toolset[]; systemPrompt?: string }) => {
			querySystemPrompt = params.systemPrompt ?? ''
			const manager = new ToolManager({ toolsets: params.toolsets, messages: () => [] })
			queryTools = manager.toLLMTools()
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

/**
 * Consumer products, apps, sites and brands that must not appear as examples.
 * Chrome and Edge are left out on purpose: they are real browser-engine
 * identifiers the browser package legitimately speaks, not examples.
 */
const CONSUMER_NAMES = [
	'Brave',
	'Firefox',
	'Safari',
	'Opera',
	'Vivaldi',
	'Notepad',
	'Spotify',
	'Slack',
	'Discord',
	'WhatsApp',
	'Telegram',
	'Gmail',
	'Outlook',
	'Facebook',
	'Instagram',
	'LinkedIn',
	'Twitter',
	'YouTube',
	'Netflix',
	'Amazon',
	'eBay',
	'Photoshop',
	'GitHub',
	'GitLab',
	'Bitbucket',
	'Jira',
	'Trello',
	'Notion',
	'Dropbox',
] as const

/**
 * Names the code genuinely needs, with the reason. A match inside one of these
 * phrases is not reported.
 */
const ALLOWED: ReadonlyArray<{ phrase: string; reason: string }> = []

function violations(text: string): string[] {
	let scrubbed = text
	for (const { phrase } of ALLOWED) scrubbed = scrubbed.split(phrase).join('')
	const hits: string[] = []
	for (const name of CONSUMER_NAMES) {
		if (new RegExp(`\\b${name}\\b`, 'i').test(scrubbed)) hits.push(name)
	}
	return hits
}

let workDir = ''
const open: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-model-text-'))
	queryTools = []
	querySystemPrompt = ''
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

describe('the text a model is given', () => {
	it('names categories, not consumer products, in the system prompt and every tool', async () => {
		const { createAgentSession } = await import('../agent.js')
		const session = await createAgentSession(prefs, detected, {
			cwd: workDir,
			enableComputerUse: true,
			browser: { profile: 'work', sites: { '*': 'ask' as const } },
		})
		open.push(session)
		for await (const _ of session.send([{ role: 'user', content: 'hi' } as never])) {
			// drain into the mocked query boundary
		}

		expect(queryTools.length, 'the turn must have mounted tools').toBeGreaterThan(5)
		expect(querySystemPrompt.length).toBeGreaterThan(0)

		const found: string[] = []
		for (const name of violations(querySystemPrompt)) found.push(`system prompt: ${name}`)
		for (const tool of queryTools) {
			const text = JSON.stringify(tool.function)
			for (const name of violations(text)) found.push(`tool ${tool.function.name}: ${name}`)
		}
		expect(found).toEqual([])
	})

	it('names categories, not consumer products, in the skill documents', () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'skills')
		const found: string[] = []
		for (const entry of readdirSync(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue
			const text = readFileSync(join(root, entry.name, 'SKILL.md'), 'utf8')
			for (const name of violations(text)) found.push(`skill ${entry.name}: ${name}`)
		}
		expect(found).toEqual([])
	})
})
