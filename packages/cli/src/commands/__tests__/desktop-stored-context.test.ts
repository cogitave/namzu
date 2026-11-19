import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompactionConfigSchema, DiskSessionLog, MockLLMProvider, drainQuery } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	closeSessions,
	loadConversationSnapshot,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { decideHeadlessTrust } from '../../permissions/headless-trust.js'
import { type AcpRuntimeDependencies, createCliAcpRuntime } from '../acp.js'
import { createDesktopHostExtensions } from '../desktop-host.js'

let root: string
let cwd: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-stored-context-'))
	cwd = join(root, 'project')
	mkdirSync(join(cwd, '.git'), { recursive: true })
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	removeTempDir(root)
})

async function fixture() {
	const runtime = createCliAcpRuntime(
		{ config: {}, formatter: { name: 'text', print() {}, info() {}, error() {} } },
		{
			decideTrust: decideHeadlessTrust,
			resolveSession: async (sessionId: string) => ({ sessionId }),
		} as unknown as AcpRuntimeDependencies,
	)
	const host = createDesktopHostExtensions(runtime, cwd)
	host['namzu/project/trust']({ confirmed: true, cwd })
	const state = await openSessions(cwd)
	const sessionId = await startConversation(state)
	const log = DiskSessionLog.at(state.paths, { sessionId })
	return {
		state,
		sessionId,
		log,
		host,
		close: async () => {
			closeSessions(state)
			await runtime.close()
		},
	}
}

/** One real turn through the kernel, with a fake provider that answers it. */
async function turn(f: Awaited<ReturnType<typeof fixture>>, model: string, counted = false) {
	await drainQuery({
		provider: new MockLLMProvider({ turns: [{ text: 'Understood.' }] }),
		toolsets: [],
		sessionLog: f.log,
		agentId: 'stored-context-agent',
		agentName: 'Stored',
		messages: [{ role: 'user', content: 'Say something short.' }],
		workingDirectory: cwd,
		...(counted
			? { compactionConfig: CompactionConfigSchema.parse({ strategy: 'sliding-window' }) }
			: {}),
		turnConfig: { model, tokenBudget: 100_000, timeoutMs: 5_000, maxIterations: 2 },
		projectId: f.state.projectId,
		sessionId: f.sessionId,
		topicId: f.state.topicId,
		tenantId: f.state.tenantId,
	})
}

it('answers the context panel from the last count in the log when the kernel recorded one', async () => {
	const f = await fixture()
	try {
		await turn(f, 'claude-sonnet-4', true)
		const snapshot = await loadConversationSnapshot(f.state, f.sessionId)
		expect(
			snapshot.records.some(
				(record) => record.type === 'token_usage_updated' && record.contextTokens !== undefined,
			),
		).toBe(true)
		const report = (await f.host['namzu/session/context']({
			sessionId: f.sessionId,
			detail: 'summary',
		})) as { stored?: string; approximate: boolean; windowTokens: number; totalTokens: number }
		expect(report.stored).toBe('record')
		expect(report.approximate).toBe(true)
		expect(report.windowTokens).toBeGreaterThan(0)
	} finally {
		await f.close()
	}
})

it('estimates from the stored messages when no count was ever recorded', async () => {
	const f = await fixture()
	try {
		await turn(f, 'claude-sonnet-4')
		const snapshot = await loadConversationSnapshot(f.state, f.sessionId)
		expect(
			snapshot.records.some(
				(record) => record.type === 'token_usage_updated' && record.contextTokens !== undefined,
			),
		).toBe(false)
		const report = (await f.host['namzu/session/context']({ sessionId: f.sessionId })) as {
			stored?: string
			measuredBy?: string
			totalTokens: number
		}
		expect(report.stored).toBe('estimate')
		expect(report.measuredBy).toBe('estimate')
		expect(report.totalTokens).toBeGreaterThan(0)
	} finally {
		await f.close()
	}
})

it('says nothing for a conversation whose model window is unknown and was never counted', async () => {
	const f = await fixture()
	try {
		await turn(f, 'no-such-model-xyz')
		expect(await f.host['namzu/session/context']({ sessionId: f.sessionId })).toBeNull()
	} finally {
		await f.close()
	}
})

it('adds the stored figure, the last turn and the folder to the history read', async () => {
	const f = await fixture()
	try {
		await turn(f, 'claude-sonnet-4')
		const history = (await f.host['namzu/conversations/history']({
			sessionId: f.sessionId,
		})) as {
			usage?: { contextTokens: number; contextWindowTokens: number; fromRecord: boolean }
			lastTurn?: string
			environment?: { cwd: string }
		}
		expect(history.lastTurn).toBe('completed')
		expect(history.environment?.cwd).toBeTruthy()
		expect(history.usage?.contextWindowTokens).toBeGreaterThan(0)
		expect(history.usage?.contextTokens).toBeGreaterThan(0)
	} finally {
		await f.close()
	}
})
