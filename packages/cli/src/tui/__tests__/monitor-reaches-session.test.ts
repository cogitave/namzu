/**
 * The monitor tool is offered deferred by every session that has a job
 * registry, is off with background tasks, and its acknowledgements reach the
 * session's ledger. Drives the real `createAgentSession` and observes what
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
	workDir = mkdtempSync(join(tmpdir(), 'namzu-monitor-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-monitor-home-'))
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

async function sessionWith(extra: { monitorTimeoutCapMs?: number } = {}) {
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

describe('the monitor tool reaches the session', () => {
	it('is offered deferred, and the cap a single-shot run asks for reaches the kernel', async () => {
		const session = await sessionWith({ monitorTimeoutCapMs: 600_000 })
		expect(session.toolNames()).toContain('monitor')
		expect(deferredNames()).toContain('monitor')
		expect(queryParams.monitorTimeoutCapMs).toBe(600_000)
		expect(session.monitors?.running()).toBe(0)
	})

	it('leaves the kernel cap alone when the host asks for none', async () => {
		await sessionWith()
		expect(queryParams).not.toHaveProperty('monitorTimeoutCapMs')
	})

	it('is absent when background tasks are switched off', async () => {
		vi.stubEnv('NAMZU_DISABLE_BACKGROUND_TASKS', '1')
		const session = await sessionWith()
		expect(session.toolNames()).not.toContain('monitor')
		expect(deferredNames()).not.toContain('monitor')
	})

	it('clears its ledger when the kernel says it delivered an event or an end', async () => {
		const session = await sessionWith()
		const monitors = session.monitors
		if (!monitors) throw new Error('the session has no monitors')
		const event = {
			id: 'b00000001:1',
			jobId: 'b00000001',
			owner: 's',
			description: 'errors',
			kind: 'output' as const,
			text: 'FAILED',
			at: 1,
			command: 'tail -f log',
		}
		monitors.addEvent(event)
		monitors.addEnd(
			{
				id: 'b00000001',
				owner: 's',
				command: 'tail -f log',
				status: 'exited',
				startedAt: 0,
				exitCode: 0,
				kind: 'monitor',
				description: 'errors',
			},
			{ stdoutChars: 6 },
		)
		expect(monitors.size).toBe(2)
		const params = queryParams as {
			onMonitorEventsDelivered(ids: string[]): void
			onJobNoticeDelivered(ids: string[]): void
		}
		params.onMonitorEventsDelivered([event.id])
		expect(monitors.size).toBe(1)
		params.onJobNoticeDelivered(['b00000001'])
		expect(monitors.size).toBe(0)
	})
})
