/**
 * The settings tools are offered deferred, and only, to a host that asks for them. Drives the real `createAgentSession` and observes what
 * `query()` receives, as `code-analysis-reaches-session.test.ts` does.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Toolset } from '@namzu/sdk'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'

let queryParams: Record<string, unknown> = {}
let queryToolsets: readonly Toolset[] = []
vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { toolsets: readonly Toolset[] }) => {
			queryToolsets = params.toolsets
			queryParams = params as unknown as Record<string, unknown>
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
			modelInputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			execute: async () => ({ success: true, output: '' }),
		},
		waitForTaskTool: {
			name: 'wait_for_task',
			description: 'stub',
			inputSchema: { type: 'object', properties: {} },
			modelInputSchema: {
				type: 'object',
				properties: {},
				additionalProperties: false,
			},
			execute: async () => ({ success: true, output: '' }),
		},
		allowedAgentIds: [],
	}),
}))

let workDir = ''
let stateRoot = ''
const open: Array<{ close(): Promise<void> }> = []

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), 'namzu-settings-tools-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-settings-tools-home-'))
	queryParams = {}
	queryToolsets = []
})

afterEach(async () => {
	vi.unstubAllEnvs()
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

async function sessionWith(extra: { settingsTools?: { cwd: string } } = {}) {
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(prefs, detected, {
		cwd: workDir,
		stateRoot,
		...extra,
	})
	open.push(session)
	for await (const _ of session.send([{ role: 'user', content: 'hello' } as never])) {
		// drain into the mocked query boundary
	}
	return session
}

const deferredNames = () =>
	queryToolsets
		.filter((ts) => ts.availability === 'deferred')
		.flatMap((ts) => ts.tools().map((t) => t.name))

describe('the settings tools reach the session', () => {
	it('adds no tool when the host did not ask: the listing is what it was', async () => {
		const session = await sessionWith()
		expect(session.toolNames()).not.toContain('get_settings')
		expect(session.toolNames()).not.toContain('set_setting')
		expect(deferredNames()).not.toContain('set_setting')
	})

	it('adds the two names, deferred, and nothing else, when the host asks', async () => {
		const before = await sessionWith()
		const baseline = before.toolNames()
		const baselineDeferred = deferredNames()
		const session = await sessionWith({ settingsTools: { cwd: workDir } })
		const added = session.toolNames().filter((name) => !baseline.includes(name))
		expect(added.sort()).toEqual(['get_settings', 'set_setting'])
		expect(
			deferredNames()
				.filter((name) => !baselineDeferred.includes(name))
				.sort(),
		).toEqual(['get_settings', 'set_setting'])
	})
})
