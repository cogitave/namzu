/**
 * The code index is a tool the session offers, and the provider behind it is
 * the one the turn hands to the kernel.
 *
 * Drives the real `createAgentSession` front door and observes what `query()`
 * receives, the way `computer-use-reaches-session.test.ts` does for the
 * desktop host: the roster it builds, and the provider on its params. Then it
 * uses that very provider through the SDK tool against a real directory, so
 * the whole path — config switch, roster, kernel params, lazy import, index —
 * is exercised without a model.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	type CodeAnalysisProvider,
	CodeAnalysisTool,
	type ToolContext,
	ToolManager,
	type Toolset,
} from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

let queryToolNames: readonly string[] = []
let queryCodeAnalysis: CodeAnalysisProvider | undefined
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { toolsets: readonly Toolset[]; codeAnalysis?: CodeAnalysisProvider }) => {
			const manager = new ToolManager({ toolsets: params.toolsets, messages: () => [] })
			queryToolNames = manager.toLLMTools().map((tool) => tool.function.name)
			queryCodeAnalysis = params.codeAnalysis
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
let stateRoot = ''
const open: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-code-analysis-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-code-analysis-home-'))
	queryToolNames = []
	queryCodeAnalysis = undefined
})

afterEach(async () => {
	for (const session of open.splice(0)) await session.close()
	removeTempDir(workDir)
	removeTempDir(stateRoot)
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

async function sessionWith(codeAnalysis?: { enabled?: boolean }) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detected, {
		cwd: workDir,
		stateRoot,
		...(codeAnalysis ? { codeAnalysis } : {}),
	})
	open.push(session)
	for await (const _ of session.send([{ role: 'user', content: 'hello' } as never])) {
		// drain into the mocked query boundary
	}
	return session
}

describe('code_analysis reaches the session', () => {
	it('is offered, with its provider on the kernel params, when the host passes the option', async () => {
		const session = await sessionWith({})
		expect(session.toolNames()).toContain('code_analysis')
		expect(queryToolNames).toContain('code_analysis')
		expect(queryCodeAnalysis).toBeDefined()
	})

	it('is absent when the config switched it off', async () => {
		const session = await sessionWith({ enabled: false })
		expect(session.toolNames()).not.toContain('code_analysis')
		expect(queryToolNames).not.toContain('code_analysis')
		expect(queryCodeAnalysis).toBeUndefined()
	})

	it('is absent for a surface that did not ask (exec, drain, acp)', async () => {
		const session = await sessionWith()
		expect(session.toolNames()).not.toContain('code_analysis')
		expect(queryCodeAnalysis).toBeUndefined()
	})

	it('answers a real question through the provider the turn was handed, and indexes under the home', async () => {
		mkdirSync(join(workDir, 'src'))
		writeFileSync(
			join(workDir, 'src', 'login.js'),
			'export function login(user) {\n  if (!user) throw new Error("Invalid credentials")\n}\n',
		)
		await sessionWith({})
		const context = {
			workingDirectory: workDir,
			codeAnalysis: queryCodeAnalysis,
		} as ToolContext

		const found = await CodeAnalysisTool.execute(
			{ operation: 'find_literal', text: 'Invalid credentials' },
			context,
		)
		expect(found.success).toBe(true)
		expect(found.output).toContain('login.js:2:')
		expect(found.output).toContain('login [declaration')
		expect(found.output).toContain('coverage: complete')

		const { readdirSync } = await import('node:fs')
		const cache = readdirSync(join(stateRoot, 'cache', 'analysis'))
		expect(cache.some((name) => name.endsWith('.sqlite'))).toBe(true)
	})
})
