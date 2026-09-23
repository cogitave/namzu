/**
 * `schedule run-now` with no scheduler running: the run is recorded as the
 * job's run in progress while it runs, and how it ends is recorded as a
 * daemon's run is — so a scheduler that starts meanwhile does not start the
 * job beside it, and a park is found by `/resume` and holds later
 * occurrences.
 */

import { join } from 'node:path'
import { NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetCliLoggerForTests } from '../../logging.js'
import { createAgentSession } from '../../tui/agent.js'
import { findScheduledPark } from '../../tui/schedule/resume.js'
import { runNowCommand } from '../commands/lifecycle.js'
import { ScheduleDaemon } from '../daemon/daemon.js'
import { foldHistory, readHistory } from '../store/history.js'
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
let responses: (() => Response)[]
beforeEach(() => {
	sb = sandbox()
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

const agent = {
	probeAgentSession: async () => ({
		preferences: null,
		needsRepickReason: null,
		detected: [DEEPSEEK],
		credentialGap: null,
	}),
	createAgentSession,
}

describe('a foreground run-now', () => {
	it('is the job’s run in progress while it runs, and a completed one is recorded once', async () => {
		const job = confirmedJob(sb, { permissions: { preset: 'read-only' } })
		let seenWhileRunning: string | undefined
		responses.push(() => {
			seenWhileRunning = readState(sb.paths, job.id).activeRun?.status
			return completion()
		})
		const code = await runNowCommand(recordingContext(), [job.name, '--home', sb.home], { agent })
		expect(code).toBe(0)
		expect(seenWhileRunning).toBe('running')
		const state = readState(sb.paths, job.id)
		expect(state.activeRun).toBeUndefined()
		expect(state.lastRun?.status).toBe('completed')
		expect(state.counters.runs).toBe(1)
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ status: 'completed', trigger: 'manual' })
	})

	it('a park is recorded, found by /resume, and holds the next occurrence', async () => {
		const job = confirmedJob(
			sb,
			{ permissions: { preset: 'edit-in-folder' }, when: 'every 1m' },
			new Date(Date.now() - 120_000),
		)
		responses.push(() =>
			completion({ name: 'bash', input: { command: `touch ${join(sb.project, 'x')}` } }),
		)
		expect(await runNowCommand(recordingContext(), [job.name, '--home', sb.home], { agent })).toBe(
			0,
		)
		const run = readState(sb.paths, job.id).activeRun
		expect(run).toMatchObject({ status: 'awaiting-approval', trigger: 'manual' })
		expect(run?.sessionId).toBeDefined()
		const park = await findScheduledPark(sb.home, run?.sessionId as string)
		expect(park?.job.id).toBe(job.id)

		const spawned: string[] = []
		const d = new ScheduleDaemon({
			paths: sb.paths,
			log: NOOP_LOGGER,
			version: 't',
			epoch: 'e',
			maxConcurrentRuns: 2,
			notifications: false,
			spawnFire: (req) => {
				spawned.push(req.runId)
				return { exited: new Promise(() => {}), terminate: () => {} }
			},
			notify: async () => {},
			fingerprint: () => 'x',
			watchJobs: false,
			now: () => Date.now() + 60_000,
		})
		await d.claimOwnership()
		await d.tick()
		expect(spawned).toEqual([])
		expect(
			readHistory(sb.paths, job.id).some(
				(r) => r.kind === 'skip' && r.reason === 'previous-run-awaiting-approval',
			),
		).toBe(true)
		await d.releaseOwnership()
	})
})
