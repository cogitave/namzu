import { NOOP_LOGGER, generateScheduleRunId } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import {
	archiveConversation,
	closeSessions,
	loadConversation,
	openConversationLog,
	openSessions,
	startConversation,
	unarchiveConversation,
} from '../../integrations/sessions/store.js'
import { confirmJob } from '../build.js'
import { ScheduleDaemon, noSessionStartGraceMs } from '../daemon/daemon.js'
import { readSourceDeliveries } from '../delivery.js'
import { readHistory } from '../store/history.js'
import { updateJob } from '../store/jobs.js'
import { readScriptState } from '../store/script-state.js'
import { readState, writeState } from '../store/state.js'
import type { ScheduleRunResult } from '../types.js'
import { type Sandbox, confirmedJob, sandbox } from './fixtures.js'

let box: Sandbox | undefined
afterEach(() => {
	box?.cleanup()
	box = undefined
})

function daemon(sb: Sandbox, now: () => number = Date.now): ScheduleDaemon {
	return new ScheduleDaemon({
		paths: sb.paths,
		log: NOOP_LOGGER,
		version: 'test',
		epoch: crypto.randomUUID(),
		maxConcurrentRuns: 1,
		notifications: false,
		spawnFire: () => {
			throw new Error('this test never dispatches')
		},
		notify: async () => {},
		fingerprint: () => 'same',
		now,
		watchJobs: false,
	})
}

it('retries a busy source after a daemon restart and delivers the result once', async () => {
	const sb = sandbox()
	box = sb
	const sessions = await openSessions(sb.project, { stateRoot: sb.home })
	try {
		const sessionId = await startConversation(sessions)
		const delivery = {
			kind: 'source-conversation' as const,
			sessionId,
			projectSlug: sessions.slug,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		}
		const job = confirmedJob(sb, {
			delivery,
			runKind: 'script',
			script: { body: 'echo check', shell: 'sh' as const, report: 'json-v1' },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		})
		const runId = generateScheduleRunId()
		const startedAt = '2026-09-30T08:00:00.000Z'
		writeState(sb.paths, {
			...readState(sb.paths, job.id),
			activeRun: {
				runId,
				key: 'manual-test',
				trigger: 'manual',
				startedAt,
				daemonEpoch: 'test',
				status: 'running',
				delivery,
			},
		})
		const result: ScheduleRunResult = {
			v: 1,
			kind: 'schedule-run-result',
			jobId: job.id,
			runId,
			status: 'completed',
			exitCode: 0,
			startedAt,
			endedAt: '2026-09-30T08:00:03.000Z',
			summary: 'Three new issues.',
			scriptReport: { v: 1, state: 'changed', summary: 'Three new issues.', nextState: 'ids:123' },
			scriptStateRevision: 0,
		}
		const log = openConversationLog(sessions, sessionId)
		const lease = await log.claim({ holder: 'source-turn', ttlMs: 30_000 })
		expect(lease).not.toBeNull()
		try {
			expect(await daemon(sb).finalizeRun(job.id, runId, result)).toBe(true)
			expect(readState(sb.paths, job.id).deliveryPending).toHaveLength(1)
			expect(readScriptState(sb.paths, job.id).state).toBe('')
			expect(await readSourceDeliveries(sb.paths, delivery)).toEqual([])
		} finally {
			if (lease) await log.release(lease)
		}
		await archiveConversation(sessions, sessionId)
		await daemon(sb).reconcileJob(job.id)
		expect(readState(sb.paths, job.id).deliveryPending).toHaveLength(1)
		expect(readState(sb.paths, job.id).lastDeliveryIssue?.reason).toMatch(/archived/)
		expect(readScriptState(sb.paths, job.id).state).toBe('')
		await unarchiveConversation(sessions, sessionId)
		// The original daemon has gone. Reconciliation by its successor must
		// use the durable pending result, then clear it without a model turn.
		await daemon(sb).reconcileJob(job.id)
		expect(readState(sb.paths, job.id).deliveryPending).toBeUndefined()
		expect(readScriptState(sb.paths, job.id)).toMatchObject({
			revision: 1,
			state: 'ids:123',
			lastRunId: runId,
		})
		await daemon(sb).reconcileJob(job.id)
		expect((await readSourceDeliveries(sb.paths, delivery)).map((item) => item.summary)).toEqual([
			'Three new issues.',
		])
		expect(await loadConversation(sessions, sessionId)).toEqual([])
	} finally {
		closeSessions(sessions)
	}
})

it('does not interrupt an adopted script before its confirmed timeout has elapsed', async () => {
	const sb = sandbox()
	box = sb
	const job = confirmedJob(sb, {
		name: 'long-poll',
		runKind: 'script',
		script: { body: 'echo check', shell: 'sh' as const, timeoutMs: 10 * 60_000 },
		permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
	})
	const startedAt = '2026-09-30T09:00:00.000Z'
	const runId = generateScheduleRunId()
	writeState(sb.paths, {
		...readState(sb.paths, job.id),
		activeRun: {
			runId,
			key: 'manual-long',
			trigger: 'manual',
			startedAt,
			daemonEpoch: 'old-daemon',
			status: 'running',
			noSessionGraceMs: noSessionStartGraceMs(job),
		},
	})
	let clock = Date.parse(startedAt) + 3 * 60_000
	const successor = daemon(sb, () => clock)
	expect((await successor.reconcileJob(job.id))?.activeRun?.runId).toBe(runId)
	clock = Date.parse(startedAt) + 11 * 60_000 + 1
	expect((await successor.reconcileJob(job.id))?.lastRun?.status).toBe('interrupted')
})

it('waives only the exact pending source result a confirmed detach named', async () => {
	const sb = sandbox()
	box = sb
	const sessions = await openSessions(sb.project, { stateRoot: sb.home })
	try {
		const sessionId = await startConversation(sessions)
		const delivery = {
			kind: 'source-conversation' as const,
			sessionId,
			projectSlug: sessions.slug,
			projectId: sessions.projectId,
			tenantId: sessions.tenantId,
		}
		const job = confirmedJob(sb, {
			delivery,
			runKind: 'script',
			script: { body: 'echo check', shell: 'sh' as const, report: 'json-v1' },
			permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
		})
		const allowed = generateScheduleRunId()
		const later = generateScheduleRunId()
		const result = (runId: string, nextState?: string): ScheduleRunResult => ({
			v: 3,
			kind: 'schedule-run-result',
			jobId: job.id,
			runId,
			status: 'completed',
			exitCode: 0,
			startedAt: '2026-09-30T09:00:00.000Z',
			endedAt: '2026-09-30T09:00:01.000Z',
			scriptReport: { v: 1, state: 'changed', summary: runId, ...(nextState ? { nextState } : {}) },
			...(nextState ? { scriptStateRevision: 0 } : {}),
		})
		writeState(sb.paths, {
			...readState(sb.paths, job.id),
			deliveryPending: [
				{ result: result(allowed, 'first'), delivery },
				{ result: result(later), delivery },
			],
		})
		await archiveConversation(sessions, sessionId)
		updateJob(sb.paths, job.id, job.revision, (current) =>
			confirmJob(
				{ ...current, delivery: undefined, deliveryWaiverRunIds: [allowed] },
				'cli-tty',
				new Date('2026-09-30T09:10:00.000Z'),
				{ paths: sb.paths },
			),
		)
		await daemon(sb).reconcileJob(job.id)
		const pending = readState(sb.paths, job.id).deliveryPending
		expect(pending?.map((item) => item.result.runId)).toEqual([later])
		expect(readState(sb.paths, job.id).lastDeliveryIssue?.reason).toMatch(/archived/)
		expect(readScriptState(sb.paths, job.id)).toMatchObject({ revision: 1, state: 'first' })
		await daemon(sb).reconcileJob(job.id)
		expect(
			readHistory(sb.paths, job.id).filter(
				(record) => record.kind === 'job' && record.action === 'delivery-waived',
			),
		).toEqual([expect.objectContaining({ detail: allowed, by: 'operator' })])
	} finally {
		closeSessions(sessions)
	}
})

it('commits a quiet script checkpoint without requiring a source conversation', async () => {
	const sb = sandbox()
	box = sb
	const job = confirmedJob(sb, {
		name: 'quiet-check',
		runKind: 'script',
		workspace: 'none',
		script: { body: 'echo check', shell: 'sh' as const, report: 'json-v1' },
		permissions: { rules: { bash: 'allow' }, unmatched: 'deny' },
	})
	const runId = generateScheduleRunId()
	const startedAt = '2026-09-30T09:00:00.000Z'
	writeState(sb.paths, {
		...readState(sb.paths, job.id),
		activeRun: {
			runId,
			key: 'manual-quiet',
			trigger: 'manual',
			startedAt,
			daemonEpoch: 'test',
			status: 'running',
		},
	})
	expect(
		await daemon(sb).finalizeRun(job.id, runId, {
			v: 3,
			kind: 'schedule-run-result',
			jobId: job.id,
			runId,
			status: 'completed',
			exitCode: 0,
			startedAt,
			endedAt: '2026-09-30T09:00:01.000Z',
			scriptReport: { v: 1, state: 'quiet', nextState: 'baseline' },
			scriptStateRevision: 0,
		}),
	).toBe(true)
	expect(readState(sb.paths, job.id).deliveryPending).toBeUndefined()
	expect(readScriptState(sb.paths, job.id)).toMatchObject({ revision: 1, state: 'baseline' })
})
