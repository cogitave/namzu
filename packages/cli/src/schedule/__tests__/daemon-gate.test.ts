/**
 * What the daemon does with a run a gate skipped, driven tick by tick with a
 * fake clock and fake runs: a skip is not a failure (no failure count, no
 * streak, no automatic pause, no failure notice, nothing delivered to a
 * source conversation), and a gate that cannot start three runs in a row is
 * told to the person once, the way a failing task is.
 */

import { NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	type DaemonNotice,
	type FireSpawnRequest,
	ScheduleDaemon,
	type SpawnedRun,
} from '../daemon/daemon.js'
import { writeRunResult } from '../fire/result.js'
import { foldHistory, readHistory } from '../store/history.js'
import { readJob } from '../store/jobs.js'
import { readState } from '../store/state.js'
import type { ScheduleRunResult, ScheduleRunStatus } from '../types.js'
import { type Sandbox, confirmedJob, sandbox } from './fixtures.js'

let sb: Sandbox
let clock: number
let spawned: FireSpawnRequest[]
let notices: DaemonNotice[]
let outcome: (req: FireSpawnRequest) => Partial<ScheduleRunResult> & { status: ScheduleRunStatus }
let holdRuns: boolean
let releases: (() => void)[]

beforeEach(() => {
	sb = sandbox()
	clock = Date.parse('2026-09-23T02:59:50Z')
	spawned = []
	notices = []
	outcome = () => ({ status: 'completed', summary: 'done' })
	holdRuns = false
	releases = []
})

afterEach(() => sb.cleanup())

function fakeSpawn(req: FireSpawnRequest): SpawnedRun {
	spawned.push(req)
	const finish = () => {
		writeRunResult(sb.paths, {
			v: 1,
			kind: 'schedule-run-result',
			runId: req.runId,
			jobId: req.job.id,
			exitCode: 0,
			startedAt: new Date(clock).toISOString(),
			endedAt: new Date(clock).toISOString(),
			...outcome(req),
		})
	}
	let resolveExit: (code: number | null) => void = () => {}
	const exited = new Promise<number | null>((resolve) => {
		resolveExit = resolve
	})
	if (holdRuns) {
		releases.push(() => {
			finish()
			resolveExit(0)
		})
	} else {
		finish()
		resolveExit(0)
	}
	return { exited, terminate: () => {} }
}

function daemon(over: Partial<ConstructorParameters<typeof ScheduleDaemon>[0]> = {}) {
	return new ScheduleDaemon({
		paths: sb.paths,
		log: NOOP_LOGGER,
		version: 'test',
		epoch: crypto.randomUUID(),
		maxConcurrentRuns: 2,
		notifications: true,
		spawnFire: fakeSpawn,
		notify: async (n) => {
			notices.push(n)
		},
		fingerprint: () => 'same',
		now: () => clock,
		monotonic: () => clock,
		watchJobs: false,
		...over,
	})
}

/** Let the exit handlers and finalisation settle. */
async function settle(d: ScheduleDaemon): Promise<void> {
	await d.settled()
}

function gated(over: Parameters<typeof confirmedJob>[1] = {}) {
	return confirmedJob(
		sb,
		{ when: 'every 1m', gate: { command: 'ls inbox' }, ...over },
		new Date(clock),
	)
}

async function minutes(d: ScheduleDaemon, n: number): Promise<void> {
	for (let i = 0; i < n; i++) {
		clock += 60_000
		await d.tick()
		await settle(d)
	}
}

const skip = (skipKind: 'silent' | 'exit' | 'timeout' | 'start', reason: string) => () =>
	({ status: 'skipped', skipKind, reason, exitCode: 0 }) as const

describe('a skipped run is not a failure', () => {
	it('records the skip with its reason and counts no failure, streak, notice or pause', async () => {
		outcome = skip('silent', 'the gate printed nothing')
		const job = gated()
		const d = daemon()
		await d.claimOwnership()
		await minutes(d, 7)
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs).toHaveLength(7)
		expect(runs[0]).toMatchObject({
			status: 'skipped',
			skipKind: 'silent',
			reason: 'the gate printed nothing',
		})
		const state = readState(sb.paths, job.id)
		expect(state.counters).toMatchObject({ runs: 7, failures: 0, failureStreak: 0, skips: 7 })
		expect(state.lastRun).toMatchObject({
			status: 'skipped',
			reason: 'the gate printed nothing',
		})
		expect(readJob(sb.paths, job.id)?.state).toBe('active')
		expect(notices).toEqual([])
	})

	it('leaves a failure streak as it was, in both directions', async () => {
		const job = gated()
		const d = daemon()
		await d.claimOwnership()
		outcome = () => ({ status: 'failed', reason: 'provider said 500', exitCode: 1 })
		await minutes(d, 1)
		outcome = skip('exit', 'the gate exited with 3')
		await minutes(d, 2)
		expect(readState(sb.paths, job.id).counters).toMatchObject({ failures: 1, failureStreak: 1 })
		outcome = () => ({ status: 'completed', summary: 'done' })
		await minutes(d, 1)
		expect(readState(sb.paths, job.id).counters.failureStreak).toBe(0)
	})

	it('delivers nothing to the source conversation for a skip', async () => {
		outcome = skip('silent', 'the gate printed nothing')
		const job = gated({
			delivery: {
				kind: 'source-conversation',
				sessionId: '01a1cd06-8405-766c-9495-fa1199a36dc2',
				projectSlug: 'project',
				projectId: 'project-id',
				tenantId: 'tenant-id',
			},
		})
		const d = daemon()
		await d.claimOwnership()
		await minutes(d, 1)
		expect(readState(sb.paths, job.id).deliveryPending ?? []).toEqual([])
	})
})

describe('a gate that cannot start', () => {
	it('is told once after three runs in a row, and does not pause the job', async () => {
		outcome = skip('start', 'the gate could not start')
		const job = gated()
		const d = daemon()
		await d.claimOwnership()
		await minutes(d, 2)
		expect(notices).toEqual([])
		await minutes(d, 1)
		expect(notices.map((n) => n.body)).toEqual([
			expect.stringMatching(
				/^its gate could not start 3 runs in a row; namzu schedule show nightly says why$/,
			),
		])
		await minutes(d, 3)
		expect(notices).toHaveLength(1)
		expect(readState(sb.paths, job.id).counters).toMatchObject({
			gateStartFailures: 6,
			failures: 0,
			failureStreak: 0,
		})
		expect(readJob(sb.paths, job.id)?.state).toBe('active')
	})

	it('starts counting again once the gate has started, and tells a later streak again', async () => {
		const job = gated()
		const d = daemon()
		await d.claimOwnership()
		outcome = skip('start', 'the gate could not start')
		await minutes(d, 3)
		expect(notices).toHaveLength(1)
		outcome = skip('silent', 'the gate printed nothing')
		await minutes(d, 1)
		expect(readState(sb.paths, job.id).counters.gateStartFailures).toBeUndefined()
		// Notifications for one job are rate limited; let the limit pass.
		clock += 3 * 60 * 60_000
		outcome = skip('start', 'the gate could not start')
		await minutes(d, 2)
		expect(notices).toHaveLength(1)
		await minutes(d, 1)
		expect(notices).toHaveLength(2)
	})
})
