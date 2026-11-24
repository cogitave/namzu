/**
 * `generate_image` is offered whatever model leads, while a subscription plan sign-in
 * is connected, the plan is not Free and the setting is on; otherwise it is
 * absent from what the model is offered. Drives the real `createAgentSession`
 * front door and observes what `query()` receives.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { SearchToolsTool, type ToolContext, ToolManager, type Toolset } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

let queryToolNames: readonly string[] = []
let queryToolsets: readonly Toolset[] = []
let queryDirectories: readonly string[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: {
			toolsets: readonly Toolset[]
			additionalDirectories?: readonly string[]
		}) => {
			const manager = new ToolManager({ toolsets: params.toolsets, messages: () => [] })
			queryToolNames = manager.toLLMTools().map((tool) => tool.function.name)
			queryToolsets = params.toolsets
			queryDirectories = params.additionalDirectories ?? []
			return (async function* () {})()
		},
	}
})

vi.mock('../../integrations/subagents/runtime.js', () => ({
	createSubagentRuntime: async () => ({
		gatewayForTurn: async () => ({}) as never,
		completionInboxForTurn: async () => new (await import('@namzu/sdk')).CompletionInbox(),
		releaseTurn: async () => {},
		liveChildSessionIds: () => new Set<string>(),
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
let stateRoot = ''
const open: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-imagegen-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-imagegen-home-'))
	queryToolNames = []
	queryToolsets = []
	queryDirectories = []
})

afterEach(async () => {
	vi.unstubAllEnvs()
	for (const session of open.splice(0)) await session.close()
	removeTempDir(workDir)
	removeTempDir(stateRoot)
})

const prefs = {
	version: 3,
	providers: [{ id: 'deepseek' }],
	subagents: { active: [] },
} as Preferences

function token(plan: string): string {
	const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
	return `${part({ alg: 'none' })}.${part({
		exp: Math.floor(Date.now() / 1000) + 3600,
		'https://api.openai.com/auth': {
			[['chatgpt', 'account_id'].join('_')]: 'acct-1',
			[['chatgpt', 'plan_type'].join('_')]: plan,
		},
	})}.sig`
}

const deepseek = [
	{
		entry: {
			id: 'deepseek',
			label: 'DeepSeek',
			defaultModel: 'deepseek-chat',
			requiresApiKey: true,
			envVars: ['DEEPSEEK_API_KEY'],
		},
		source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
] as unknown as DetectedProvider[]

const codex = (plan: string) =>
	({
		entry: {
			id: 'codex',
			label: 'OpenAI (Codex subscription)',
			defaultModel: 'gpt-5',
			requiresApiKey: true,
			envVars: [],
		},
		source: { kind: 'stored' },
		apiKey: token(plan),
		codex: { accountId: 'acct-1', origin: 'stored' },
		alternatives: [],
	}) as unknown as DetectedProvider

const apiKeyOnly = {
	entry: {
		id: 'openai',
		label: 'OpenAI',
		defaultModel: 'gpt-5',
		requiresApiKey: true,
		envVars: ['OPENAI_API_KEY'],
	},
	source: { kind: 'env', envName: 'OPENAI_API_KEY' },
	apiKey: 'not-a-real-key',
	alternatives: [],
} as unknown as DetectedProvider

async function sessionWith(
	list: readonly DetectedProvider[],
	imageGeneration?: { enabled?: boolean },
	toolLoading: 'eager' | 'deferred' = 'eager',
) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, list as DetectedProvider[], {
		cwd: workDir,
		stateRoot,
		toolLoading,
		...(imageGeneration ? { imageGeneration } : {}),
	})
	open.push(session)
	for await (const _ of session.send([{ role: 'user', content: 'hello' } as never])) {
		// drain into the mocked query boundary
	}
	return session
}

describe('generate_image reaches the session', () => {
	it('is offered to a model that is not OpenAI, while a paid subscription sign-in is connected', async () => {
		await sessionWith([...deepseek, codex('plus')])
		expect(queryToolNames).toContain('generate_image')
		// The folder the images are saved in is readable by this session's file tools.
		expect(queryDirectories.some((dir) => /generated_images/.test(dir))).toBe(true)
	})

	it('is absent with no subscription sign-in', async () => {
		await sessionWith([...deepseek])
		expect(queryToolNames).not.toContain('generate_image')
		expect(queryDirectories.some((dir) => /generated_images/.test(dir))).toBe(false)
	})

	it('is absent when only an OpenAI API key is present', async () => {
		await sessionWith([...deepseek, apiKeyOnly])
		expect(queryToolNames).not.toContain('generate_image')
	})

	it('is absent on the Free plan', async () => {
		await sessionWith([...deepseek, codex('free')])
		expect(queryToolNames).not.toContain('generate_image')
	})

	it('is absent when the setting is off, and on when the setting only says enabled', async () => {
		await sessionWith([...deepseek, codex('pro')], { enabled: false })
		expect(queryToolNames).not.toContain('generate_image')
		await sessionWith([...deepseek, codex('pro')], { enabled: true })
		expect(queryToolNames).toContain('generate_image')
	})

	it('is on by default when the host passes no setting', async () => {
		await sessionWith([...deepseek, codex('team')])
		expect(queryToolNames).toContain('generate_image')
	})

	it('is found by search_tools from what a person would ask for, and is not sent until loaded', async () => {
		await sessionWith([...deepseek, codex('plus')], undefined, 'deferred')
		expect(queryToolNames).not.toContain('generate_image')
		const manager = new ToolManager({ toolsets: queryToolsets, messages: () => [] })
		const context = {
			workingDirectory: workDir,
			toolRegistry: manager.view(),
		} as unknown as ToolContext
		for (const query of ['generate_image', 'generate image', 'draw a picture', 'edit an image']) {
			const reply = await SearchToolsTool.execute({ query }, context)
			expect(reply.success).toBe(true)
			expect(reply.reveals, query).toContain('generate_image')
		}
	})
})
