import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskSessionTokenBudgetStore, generateCheckpointId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	closeSessions,
	conversationLogPath,
	openConversationLog,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import { readProviderRetryStatus } from '../acp-provider-retry.js'
import { providerPaused } from './support/provider-paused.js'

let root: string
let state: Awaited<ReturnType<typeof openSessions>>
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-provider-retry-status-'))
	state = await openSessions(root, { stateRoot: join(root, 'state') })
})
afterEach(() => {
	closeSessions(state)
	removeTempDir(root)
})

describe('durable provider retry eligibility', () => {
	it('selects the exact verified checkpoint only after usage is measured', async () => {
		const f = await providerPaused(state)
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			retry: { turnId: f.turnId, checkpointId: f.checkpointId },
		})
	})
	it('retries an unlimited turn whose one request has unknown usage, leaving that usage recorded', async () => {
		const f = await providerPaused(state, { unresolved: true })
		const store = new DiskSessionTokenBudgetStore({ paths: state.paths })
		const before = await store.load(f.budgetScope)
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			retry: { turnId: f.turnId, checkpointId: f.checkpointId },
			unknownUsage: 1,
		})
		expect(await store.load(f.budgetScope)).toEqual(before)
	})
	it.each([
		{ poisoned: true },
		{ unresolved: true, poisoned: true },
		{ unresolved: true, limit: 1_000_000 },
	])('retains a turn with unknown accounting it cannot admit past: %j', async (options) => {
		const f = await providerPaused(state, options)
		const journal = await readFile(conversationLogPath(state, f.sessionId), 'utf8')
		const store = new DiskSessionTokenBudgetStore({ paths: state.paths })
		const before = await store.load(f.budgetScope)
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			notice: expect.stringContaining('actual provider usage receipt'),
		})
		expect(await store.load(f.budgetScope)).toEqual(before)
		expect(await readFile(conversationLogPath(state, f.sessionId), 'utf8')).toBe(journal)
	})
	it.each([
		{ failure: undefined, providerError: undefined },
		{
			failure: { code: 'auth', message: 'Login required', retryable: false },
			providerError: { kind: 'auth' as const, providerId: 'zen' },
		},
		{
			failure: { code: 'bad_request', message: 'Invalid request', retryable: true },
			providerError: { kind: 'bad_request' as const, providerId: 'zen' },
		},
		{ handoff: { kind: 'human-required' as const, reason: 'Operator must finish this step' } },
	])('does not retry decisions or nonrecoverable failures: %j', async (pause) => {
		const f = await providerPaused(state, { pause })
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			notice: expect.stringContaining('paused'),
		})
	})
	it('never treats a retained human review as a provider Retry', async () => {
		const f = await providerPaused(state)
		const lease = await f.log.claim({ holder: 'test-review', ttlMs: 60_000 })
		if (!lease) throw new Error('Fixture writer unavailable')
		try {
			await f.log.append(lease, {
				type: 'decision_requested',
				turnId: f.turnId,
				checkpointId: f.checkpointId,
				decisionId: 'original-review',
				request: { type: 'tool_review', checkpointId: f.checkpointId, toolCalls: [] } as never,
			})
		} finally {
			await f.log.release(lease)
		}
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			notice: expect.stringContaining('Retry cannot approve'),
		})
	})
	it('retains the original exhausted allowance instead of creating a new ledger', async () => {
		const f = await providerPaused(state, { limit: 6 })
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			notice: expect.stringContaining('original token allowance is exhausted'),
		})
	})
	it('retains a missing checkpoint and rejects changed checkpoint bytes', async () => {
		const missing = await providerPaused(state, { withCheckpoint: false })
		expect(await readProviderRetryStatus(state, missing.sessionId)).toEqual({
			notice: expect.stringContaining('unavailable'),
		})
		const f = await providerPaused(state)
		const path = state.paths.checkpointFile({ sessionId: f.sessionId }, f.checkpointId)
		const document = JSON.parse(await readFile(path, 'utf8'))
		await writeFile(path, JSON.stringify({ ...document, iteration: 8 }))
		await expect(readProviderRetryStatus(state, f.sessionId)).rejects.toMatchObject({
			name: 'CheckpointIntegrityError',
		})
	})
	it('distinguishes idle from every active paused turn and an active resumption', async () => {
		const idle = await startConversation(state)
		expect(await readProviderRetryStatus(state, idle)).toEqual({})
		const f = await providerPaused(state)
		const log = openConversationLog(state, f.sessionId)
		const lease = (await log.claim({ holder: 'test-resuming', ttlMs: 60_000 }))!
		try {
			await log.append(lease, {
				type: 'turn_resuming',
				turnId: f.turnId,
				fromCheckpointId: generateCheckpointId(),
			})
		} finally {
			await log.release(lease)
		}
		expect(await readProviderRetryStatus(state, f.sessionId)).toEqual({
			notice: expect.stringContaining('active turn'),
		})
	})
	it('rejects another project’s durable scope', async () => {
		const f = await providerPaused(state)
		await mkdir(join(root, 'foreign'))
		const other = await openSessions(join(root, 'foreign'), { stateRoot: join(root, 'state') })
		try {
			await expect(
				readProviderRetryStatus({ ...state, projectId: other.projectId }, f.sessionId),
			).rejects.toThrow('does not belong')
		} finally {
			closeSessions(other)
		}
	})
})
