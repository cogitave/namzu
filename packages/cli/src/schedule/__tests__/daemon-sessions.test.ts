/**
 * The daemon against real run sessions: a parked run skips the job's next
 * occurrences until someone answers it; an answer nobody gives in time
 * abandons the turn and records `approval-expired`, after which the job runs
 * again; a run answered and finished in the TUI is finalised from its
 * session log; old completed runs are archived, parked and failed ones never.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { NOOP_LOGGER, asSessionId } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	closeSessions,
	openSessions,
	readConversationFacts,
	startConversation,
} from '../../integrations/sessions/store.js'
import { __resetCliLoggerForTests } from '../../logging.js'
import { createAgentSession } from '../../tui/agent.js'
import { type FireSpawnRequest, ScheduleDaemon, type SpawnedRun } from '../daemon/daemon.js'
import { archiveOldRuns, sessionsToArchive } from '../daemon/retention.js'
import { runFire } from '../fire/fire.js'
import { appendHistory, foldHistory, readHistory } from '../store/history.js'
import { readState } from '../store/state.js'
import {
	DEEPSEEK,
	type Sandbox,
	completion,
	confirmedJob,
	recordingContext,
	sandbox,
} from './fixtures.js'

let sb: Sandbox
let clock: number
let responses: (() => Response)[]

beforeEach(() => {
	sb = sandbox()
	clock = Date.parse('2026-09-23T02:59:50Z')
	responses = []
	vi.stubGlobal(
		'fetch',
		vi.fn<typeof fetch>(async () => (responses.shift() ?? completion)()),
	)
})

afterEach(() => {
	vi.unstubAllGlobals()
	__resetCliLoggerForTests()
	sb.cleanup()
})

function inProcessSpawn(req: FireSpawnRequest): SpawnedRun {
	const exited = runFire(
		recordingContext(),
		sb.paths,
		{
			jobId: req.job.id,
			runId: req.runId,
			key: req.key,
			revision: req.job.revision,
			trigger: req.trigger,
			...(req.scheduledFor ? { scheduledFor: req.scheduledFor } : {}),
		},
		{
			keepLogging: true,
			agent: {
				probeAgentSession: async () => ({
					preferences: null,
					needsRepickReason: null,
					detected: [DEEPSEEK],
					credentialGap: null,
				}),
				createAgentSession,
			},
		},
	).then((code) => code)
	return { exited, terminate: () => {} }
}

function daemon() {
	return new ScheduleDaemon({
		paths: sb.paths,
		log: NOOP_LOGGER,
		version: 'test',
		epoch: crypto.randomUUID(),
		maxConcurrentRuns: 2,
		notifications: false,
		spawnFire: inProcessSpawn,
		notify: async () => {},
		fingerprint: () => 'same',
		now: () => clock,
		monotonic: () => clock,
		watchJobs: false,
	})
}

async function waitForRun(jobId: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		const state = readState(sb.paths, jobId)
		if (state.activeRun?.status !== 'running' && !state.queued) return
		await new Promise((r) => setTimeout(r, 10))
	}
	throw new Error('run did not settle')
}

describe('a parked scheduled run', () => {
	it('skips the next occurrence, then expires, abandons the turn, and lets the job run again', async () => {
		const marker = join(sb.project, 'marker')
		const job = confirmedJob(
			sb,
			{ when: 'every 1m', permissions: { preset: 'edit-in-folder' }, approvalTtlMs: 5 * 60_000 },
			new Date(clock),
		)
		responses.push(() => completion({ name: 'bash', input: { command: `touch ${marker}` } }))
		const d = daemon()
		await d.claimOwnership()
		clock += 60_000
		await d.tick()
		await waitForRun(job.id)
		const parked = readState(sb.paths, job.id).activeRun
		expect(parked?.status).toBe('awaiting-approval')
		expect(existsSync(marker)).toBe(false)

		clock += 60_000
		await d.tick()
		expect(
			readHistory(sb.paths, job.id).some(
				(r) => r.kind === 'skip' && r.reason === 'previous-run-awaiting-approval',
			),
		).toBe(true)

		clock += 5 * 60_000
		await d.tick()
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs.find((r) => r.kind === 'run' && r.runId === parked?.runId)).toMatchObject({
			status: 'approval-expired',
		})
		const sessions = await openSessions(sb.project, { stateRoot: sb.home })
		try {
			const facts = await readConversationFacts(sessions, asSessionId(parked?.sessionId as string))
			expect(facts?.activeTurn).toBeUndefined()
		} finally {
			closeSessions(sessions)
		}
		// The same tick that expired it ran the occurrence that was due.
		await waitForRun(job.id)
		await d.settled()
		expect(readState(sb.paths, job.id).activeRun).toBeUndefined()
		expect(
			foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')[0],
		).toMatchObject({
			status: 'completed',
		})
	})
})

describe('retention', () => {
	it('archives completed runs beyond the newest keepSessions, never parked or failed ones', async () => {
		const job = confirmedJob(sb, { keepSessions: 20 })
		const sessions = await openSessions(sb.project, { stateRoot: sb.home })
		const completed: Awaited<ReturnType<typeof startConversation>>[] = []
		try {
			for (let i = 0; i < 25; i++) completed.push(await startConversation(sessions))
			const parked = await startConversation(sessions)
			const failed = await startConversation(sessions)
			const at = (i: number) =>
				new Date(Date.parse('2026-09-01T00:00:00Z') + i * 60_000).toISOString()
			completed.forEach((sessionId, i) =>
				appendHistory(sb.paths, job.id, {
					v: 1,
					kind: 'run',
					at: at(i),
					runId: `r${i}`,
					key: String(i),
					trigger: 'scheduled',
					startedAt: at(i),
					status: 'completed',
					sessionId,
				}),
			)
			appendHistory(sb.paths, job.id, {
				v: 1,
				kind: 'run',
				at: at(30),
				runId: 'p',
				key: '30',
				trigger: 'scheduled',
				startedAt: at(30),
				status: 'awaiting-approval',
				sessionId: parked,
			})
			appendHistory(sb.paths, job.id, {
				v: 1,
				kind: 'run',
				at: at(31),
				runId: 'f',
				key: '31',
				trigger: 'scheduled',
				startedAt: at(31),
				status: 'failed',
				sessionId: failed,
			})
			const doomed = sessionsToArchive(sb.paths, job, {})
			expect(doomed).toEqual(completed.slice(0, 5).reverse())
			const archived = await archiveOldRuns(sb.paths, job, {})
			expect(archived).toHaveLength(5)
			for (const id of completed.slice(0, 5))
				expect((await readConversationFacts(sessions, id))?.archived).toBe(true)
			for (const id of [...completed.slice(5), parked, failed])
				expect((await readConversationFacts(sessions, id))?.archived).toBe(false)
			expect(sessionsToArchive(sb.paths, job, { archivedSessions: archived })).toEqual([])
		} finally {
			closeSessions(sessions)
		}
	})
})
