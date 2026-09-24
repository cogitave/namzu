/**
 * The daemon's decisions, driven tick by tick with a fake clock and fake
 * runs: claims at dispatch, the concurrency cap and folder lanes, failure
 * handling (one notification per failure, a quota hold, auto-pause), holding
 * a job whose file changed behind the CLI's back, the fenced lease with
 * standby and takeover, and draining for an upgrade.
 */

import { readdirSync } from 'node:fs'
import { DiskSessionLeaseStore, NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildJob, confirmJob } from '../build.js'
import {
	type DaemonNotice,
	EXIT_STOP_REQUESTED,
	type FireSpawnRequest,
	ScheduleDaemon,
	type SpawnedRun,
	requestStop,
} from '../daemon/daemon.js'
import { writeRunResult } from '../fire/result.js'
import { isClaimed } from '../store/claims.js'
import { foldHistory, readHistory } from '../store/history.js'
import { createJob, deleteJob, readJob } from '../store/jobs.js'
import { readState } from '../store/state.js'
import type { ScheduleRunResult, ScheduleRunStatus } from '../types.js'
import { type Sandbox, confirmedJob, jobRequest, sandbox } from './fixtures.js'

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
	for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5))
	await d.settled()
}

describe('dispatch', () => {
	it('fires on time and claims the occurrence when the run starts', async () => {
		const job = confirmedJob(sb, {}, new Date(clock - 60_000))
		const d = daemon()
		await d.claimOwnership()
		await d.tick()
		expect(spawned).toHaveLength(0)
		clock = Date.parse('2026-09-23T03:00:02Z')
		await d.tick()
		await settle(d)
		expect(spawned).toHaveLength(1)
		const key = String(Date.parse('2026-09-23T03:00:00Z'))
		expect(isClaimed(sb.paths, job.id, key)).toBe(true)
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs[0]).toMatchObject({ status: 'completed', trigger: 'scheduled' })
		expect(readState(sb.paths, job.id).lastRun?.status).toBe('completed')
		expect(notices.map((n) => n.body)).toEqual([expect.stringMatching(/^finished at /)])
		expect(notices[0]?.body).not.toContain('done')
	})

	it('says a completed run had a call refused: history, state and the notification', async () => {
		const refusal = {
			count: 1,
			first: { tool: 'bash', reason: 'the scheduled-run floor refused this call: …' },
		}
		outcome = () => ({ status: 'completed', summary: 'done', refusedCalls: refusal })
		const job = confirmedJob(sb, {}, new Date(clock - 60_000))
		const d = daemon()
		await d.claimOwnership()
		clock = Date.parse('2026-09-23T03:00:02Z')
		await d.tick()
		await settle(d)
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs[0]).toMatchObject({ status: 'completed', refusedCalls: refusal })
		const state = readState(sb.paths, job.id)
		expect(state.lastRun).toMatchObject({ status: 'completed', refusedCalls: 1 })
		// Still a completed run: no failure is counted.
		expect(state.counters).toMatchObject({ failures: 0, failureStreak: 0 })
		// The reason can quote the model's command, and the job did not ask
		// for its summary on the lock screen: the tool is named instead.
		expect(notices.map((n) => n.body)).toEqual([
			expect.stringMatching(
				/^done at .+, but 1 call was refused \(bash\); namzu schedule show nightly says why$/,
			),
		])
	})

	it('a run waiting for a slot is not claimed, and after a restart it runs exactly once', async () => {
		holdRuns = true
		const created = new Date(clock - 60_000)
		const jobs = ['a', 'b', 'c'].map((name) =>
			confirmedJob(sb, { name, folder: sb.project, permissions: { preset: 'read-only' } }, created),
		)
		clock = Date.parse('2026-09-23T03:00:01Z')
		const first = daemon()
		await first.claimOwnership()
		await first.tick()
		expect(spawned).toHaveLength(2)
		const waiting = jobs.find((j) => !spawned.some((s) => s.job.id === j.id))
		expect(waiting).toBeDefined()
		const key = String(Date.parse('2026-09-23T03:00:00Z'))
		expect(isClaimed(sb.paths, waiting?.id as string, key)).toBe(false)
		// The daemon dies; its two runs finish; a new daemon starts.
		for (const release of releases.splice(0)) release()
		await first.releaseOwnership()
		clock += 30_000
		const second = daemon()
		await second.claimOwnership()
		await second.tick()
		await second.tick()
		await settle(second)
		const forWaiting = spawned.filter((s) => s.job.id === waiting?.id)
		expect(forWaiting).toHaveLength(1)
		expect(isClaimed(sb.paths, waiting?.id as string, key)).toBe(true)
		const run = foldHistory(readHistory(sb.paths, waiting?.id as string)).find(
			(r) => r.kind === 'run',
		)
		expect(run).toMatchObject({ delayReason: 'concurrency-cap' })
	})

	it('runs write-capable jobs in one folder one after the other', async () => {
		holdRuns = true
		const created = new Date(clock - 60_000)
		confirmedJob(sb, { name: 'one', permissions: { preset: 'edit-in-folder' } }, created)
		confirmedJob(sb, { name: 'two', permissions: { preset: 'edit-in-folder' } }, created)
		clock = Date.parse('2026-09-23T03:00:01Z')
		const d = daemon()
		await d.claimOwnership()
		await d.tick()
		expect(spawned).toHaveLength(1)
		for (const release of releases.splice(0)) release()
		await settle(d)
		clock += 5_000
		await d.tick()
		for (const release of releases.splice(0)) release()
		await settle(d)
		expect(spawned).toHaveLength(2)
		const second = spawned[1]?.job.id as string
		expect(foldHistory(readHistory(sb.paths, second)).find((r) => r.kind === 'run')).toMatchObject({
			delayReason: 'folder-busy',
		})
	})

	it('never fires a job created without a terminal, and says so once', async () => {
		const built = buildJob(jobRequest(sb), {
			paths: sb.paths,
			config: {},
			now: new Date(clock - 60_000),
			osHome: sb.osHome,
		})
		createJob(sb.paths, confirmJob(built, 'cli-noninteractive', new Date(clock - 60_000)))
		clock = Date.parse('2026-09-23T03:00:01Z')
		const d = daemon()
		await d.claimOwnership()
		await d.tick()
		await d.tick()
		expect(spawned).toHaveLength(0)
		expect(notices.map((n) => n.body)).toEqual([expect.stringMatching(/needs confirmation/)])
	})

	it('holds a job whose file was edited behind the CLI, records it, and notifies once', async () => {
		const job = confirmedJob(sb, {}, new Date(clock - 60_000))
		const { writeFileSync, readFileSync } = await import('node:fs')
		const file = sb.paths.job(job.id)
		writeFileSync(
			file,
			JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), prompt: 'something else' }),
		)
		clock = Date.parse('2026-09-23T03:00:01Z')
		const d = daemon()
		await d.claimOwnership()
		await d.tick()
		await d.tick()
		expect(spawned).toHaveLength(0)
		expect(readJob(sb.paths, job.id)?.state).toBe('pending-confirmation')
		expect(
			readHistory(sb.paths, job.id).some((r) => r.kind === 'job' && r.action === 'tampered'),
		).toBe(true)
		expect(notices).toHaveLength(1)
		expect(notices[0]?.body).toMatch(/changed outside namzu/)
	})
})

describe('failures', () => {
	it('tells the same failure once, and pauses the job after five in a row', async () => {
		outcome = () => ({ status: 'failed', reason: 'provider said 500 at 12:00:01', exitCode: 1 })
		const job = confirmedJob(sb, { when: 'every 1m' }, new Date(clock))
		const d = daemon()
		await d.claimOwnership()
		for (let i = 0; i < 7; i++) {
			clock += 60_000
			await d.tick()
			await settle(d)
		}
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs).toHaveLength(5)
		expect(readJob(sb.paths, job.id)?.state).toBe('paused')
		expect(readJob(sb.paths, job.id)?.pausedBy).toBe('auto-failure-streak')
		const bodies = notices.map((n) => n.body)
		expect(bodies.filter((b) => b.startsWith('failed'))).toHaveLength(1)
		expect(bodies.some((b) => /paused after 5 failed runs/.test(b))).toBe(true)
	})

	it('holds the job while the provider asked to be left alone', async () => {
		outcome = () => ({
			status: 'failed',
			reason: 'rate limited',
			exitCode: 75,
			retryAfterMs: 3_600_000,
		})
		const job = confirmedJob(sb, { when: 'every 1m' }, new Date(clock))
		const d = daemon()
		await d.claimOwnership()
		clock += 60_000
		await d.tick()
		await settle(d)
		outcome = () => ({ status: 'completed' })
		for (let i = 0; i < 3; i++) {
			clock += 60_000
			await d.tick()
			await settle(d)
		}
		expect(spawned).toHaveLength(1)
		const skips = readHistory(sb.paths, job.id).filter((r) => r.kind === 'skip')
		expect(skips.every((s) => s.kind === 'skip' && s.reason === 'quota-hold')).toBe(true)
		expect(skips.length).toBeGreaterThanOrEqual(3)
		clock += 3_600_000
		await d.tick()
		await settle(d)
		expect(spawned).toHaveLength(2)
	})
})

describe('notifications', () => {
	it('announces a park even right after the catch-up notice for the same run', async () => {
		outcome = () => ({
			status: 'awaiting-approval',
			sessionId: 'ses_parked',
			projectSlug: 'project',
			turnId: 'turn_parked',
		})
		// A nightly job, created days ago, and a scheduler that was not running.
		const job = confirmedJob(sb, {}, new Date(Date.parse('2026-09-19T00:00:00Z')))
		clock = Date.parse('2026-09-23T06:10:00Z')
		const d = daemon()
		await d.claimOwnership()
		await d.tick()
		await settle(d)
		expect(spawned).toHaveLength(1)
		expect(readState(sb.paths, job.id).activeRun?.status).toBe('awaiting-approval')
		expect(notices.map((n) => n.body)).toEqual([
			expect.stringMatching(/^catch-up run for /),
			expect.stringMatching(/approval/),
		])
	})
})

describe('one owner', () => {
	it('a second daemon waits on standby and takes over when the owner releases', async () => {
		const a = daemon({ tickMs: 20, standbyPollMs: 20 })
		const b = daemon({ tickMs: 20, standbyPollMs: 20 })
		clock = Date.now()
		const aDone = a.run()
		await new Promise((r) => setTimeout(r, 60))
		const bDone = b.run()
		await new Promise((r) => setTimeout(r, 80))
		expect(a.standby).toBe(false)
		expect(b.standby).toBe(true)
		a.stop()
		expect(await aDone).toBe(0)
		await new Promise((r) => setTimeout(r, 120))
		expect(b.standby).toBe(false)
		expect(b.lease).not.toBeNull()
		b.stop()
		expect(await bDone).toBe(0)
	})

	it('takes over a lease whose holder died once it expires; racing takers get exactly one fence', async () => {
		const store = new DiskSessionLeaseStore(sb.paths.daemon)
		const dead = await store.claim({ holder: 'dead', ttlMs: 150, now: Date.now() })
		expect(dead).not.toBeNull()
		const takers = await Promise.all(
			Array.from({ length: 6 }, (_, i) =>
				store.claim({ holder: `t${i}`, ttlMs: 60_000, now: Date.now() + 1_000 }),
			),
		)
		const winners = takers.filter((t) => t !== null)
		expect(winners).toHaveLength(1)
		const fences = readdirSync(sb.paths.daemon).filter((n) => /^lease\.\d+\.json$/.test(n))
		expect(fences.length).toBeGreaterThanOrEqual(2)
	})

	it('--once-or-exit exits 75 while another owns the home', async () => {
		const owner = daemon({ tickMs: 20 })
		clock = Date.now()
		const ownerDone = owner.run()
		await new Promise((r) => setTimeout(r, 50))
		const second = daemon({ onceOrExit: true })
		expect(await second.run()).toBe(75)
		owner.stop()
		await ownerDone
	})
})

describe('upgrades', () => {
	it('stops dispatching when the installed CLI changes, waits for its runs, and exits 0', async () => {
		holdRuns = true
		let fingerprint = 'v1'
		confirmedJob(sb, { when: 'every 1m' }, new Date(Date.now() - 61_000))
		clock = Date.now()
		const d = daemon({
			tickMs: 20,
			fingerprint: () => fingerprint,
			now: () => Date.now(),
			monotonic: () => Date.now(),
		})
		const done = d.run()
		await vi.waitFor(() => expect(spawned).toHaveLength(1), { timeout: 5_000 })
		fingerprint = 'v2'
		await vi.waitFor(() => expect(d.status().draining).toBe(true), { timeout: 5_000 })
		let finished = false
		void done.then(() => {
			finished = true
		})
		expect(finished).toBe(false)
		for (const release of releases.splice(0)) release()
		expect(await done).toBe(0)
		expect(spawned).toHaveLength(1)
	}, 12_000)

	it("leaves another job's occurrence that comes due during a drain to the daemon that takes over", async () => {
		holdRuns = true
		confirmedJob(
			sb,
			{ name: 'long', permissions: { preset: 'read-only' } },
			new Date(clock - 60_000),
		)
		const oneShot = confirmedJob(
			sb,
			{ name: 'once', when: '2026-09-23T03:10:00Z' },
			new Date(clock - 60_000),
		)
		clock = Date.parse('2026-09-23T03:00:01Z')
		const first = daemon()
		await first.claimOwnership()
		await first.tick()
		expect(spawned.map((s) => s.job.name)).toEqual(['long'])
		first.drainAndRestart()
		clock = Date.parse('2026-09-23T03:10:40Z')
		await first.tick()
		expect(spawned.map((s) => s.job.name)).toEqual(['long'])
		// The long run ends; the draining daemon exits; a fresh one takes over.
		for (const release of releases.splice(0)) release()
		await settle(first)
		await first.releaseOwnership()
		holdRuns = false
		clock += 5_000
		const second = daemon()
		await second.claimOwnership()
		await second.tick()
		await settle(second)
		expect(spawned.map((s) => s.job.name)).toEqual(['long', 'once'])
		expect(readJob(sb.paths, oneShot.id)?.state).toBe('completed')
		expect(
			foldHistory(readHistory(sb.paths, oneShot.id)).find((r) => r.kind === 'run'),
		).toMatchObject({ status: 'completed' })
	})
})

describe('a run-now during an upgrade drain', () => {
	it('is kept on disk and started by the daemon that takes over', async () => {
		holdRuns = true
		confirmedJob(
			sb,
			{ name: 'long', permissions: { preset: 'read-only' } },
			new Date(clock - 60_000),
		)
		const other = confirmedJob(sb, { name: 'other', when: '0 9 * * *' }, new Date(clock - 60_000))
		clock = Date.parse('2026-09-23T03:00:01Z')
		const first = daemon()
		await first.claimOwnership()
		await first.tick()
		first.drainAndRestart()
		const answer = first.requestRunNow(other.id)
		expect(answer.ok).toBe(true)
		expect(answer.message).toMatch(/restarting/)
		expect(first.requestRunNow(other.id).ok).toBe(false)
		await first.tick()
		expect(spawned.map((s) => s.job.name)).toEqual(['long'])
		for (const release of releases.splice(0)) release()
		await settle(first)
		await first.releaseOwnership()
		holdRuns = false
		clock += 5_000
		const second = daemon()
		await second.claimOwnership()
		await second.tick()
		await settle(second)
		expect(spawned.map((s) => s.job.name)).toEqual(['long', 'other'])
		const started = spawned[1]
		const runs = foldHistory(readHistory(sb.paths, other.id)).filter((r) => r.kind === 'run')
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ status: 'completed', trigger: 'manual', runId: started?.runId })
		expect(runs[0]).not.toHaveProperty('scheduledFor')
		expect(runs[0]).not.toHaveProperty('delayedMs')
		expect(started?.key).toBe(`manual-${started?.runId}`)
		expect(readState(sb.paths, other.id).queued).toBeUndefined()
	})
})

describe('a run-now accepted before a drain and still waiting when it starts', () => {
	for (const how of ['an upgrade request', 'a changed install'] as const) {
		it(`is moved to disk when ${how} starts the drain`, async () => {
			holdRuns = true
			let fingerprint = 'same'
			confirmedJob(
				sb,
				{ name: 'long', permissions: { preset: 'read-only' } },
				new Date(clock - 60_000),
			)
			const other = confirmedJob(sb, { name: 'other', when: '0 9 * * *' }, new Date(clock - 60_000))
			clock = Date.parse('2026-09-23T03:00:01Z')
			const first = daemon({ maxConcurrentRuns: 1, fingerprint: () => fingerprint })
			await first.claimOwnership()
			await first.tick()
			expect(spawned.map((s) => s.job.name)).toEqual(['long'])
			const answer = first.requestRunNow(other.id)
			expect(answer).toMatchObject({ ok: true })
			// The cap is full: the request waits in memory.
			await first.tick()
			expect(spawned.map((s) => s.job.name)).toEqual(['long'])
			expect(readState(sb.paths, other.id).queued).toBeUndefined()
			if (how === 'an upgrade request') first.drainAndRestart()
			else fingerprint = 'upgraded'
			await first.tick()
			expect(readState(sb.paths, other.id).queued).toMatchObject({ trigger: 'manual' })
			expect(first.requestRunNow(other.id).ok).toBe(false)
			for (const release of releases.splice(0)) release()
			await settle(first)
			await first.releaseOwnership()
			holdRuns = false
			clock += 5_000
			const second = daemon({ maxConcurrentRuns: 1, fingerprint: () => fingerprint })
			await second.claimOwnership()
			await second.tick()
			await settle(second)
			expect(spawned.map((s) => s.job.name)).toEqual(['long', 'other'])
			const runs = foldHistory(readHistory(sb.paths, other.id)).filter((r) => r.kind === 'run')
			expect(runs).toHaveLength(1)
			expect(runs[0]).toMatchObject({ status: 'completed', trigger: 'manual' })
			expect(readState(sb.paths, other.id).queued).toBeUndefined()
		})
	}
})

describe('a job removed while its run goes on', () => {
	it('gets the run’s end in its history when the run exits', async () => {
		holdRuns = true
		const job = confirmedJob(sb, {}, new Date(clock - 60_000))
		clock = Date.parse('2026-09-23T03:00:01Z')
		const d = daemon()
		await d.claimOwnership()
		await d.tick()
		expect(spawned).toHaveLength(1)
		deleteJob(sb.paths, job.id)
		for (const release of releases.splice(0)) release()
		await settle(d)
		const runs = foldHistory(readHistory(sb.paths, job.id)).filter((r) => r.kind === 'run')
		expect(runs).toHaveLength(1)
		expect(runs[0]).toMatchObject({ status: 'completed', runId: spawned[0]?.runId })
		expect(runs[0]).toHaveProperty('endedAt')
	})
})

describe('schedule stop', () => {
	it('reaches a daemon on standby, which has no endpoint, through the stop request', async () => {
		const owner = daemon({ tickMs: 20, standbyPollMs: 20 })
		clock = Date.now()
		const ownerDone = owner.run()
		await new Promise((r) => setTimeout(r, 50))
		const standby = daemon({ tickMs: 20, standbyPollMs: 20 })
		const standbyDone = standby.run()
		await new Promise((r) => setTimeout(r, 60))
		expect(standby.standby).toBe(true)
		requestStop(sb.paths, true)
		expect(await standbyDone).toBe(EXIT_STOP_REQUESTED)
		expect(await ownerDone).toBe(EXIT_STOP_REQUESTED)
		// Started again while the request stands (by hand, or at login): it
		// exits at once with the code the systemd unit does not restart on.
		expect(await daemon({ standbyPollMs: 20 }).run()).toBe(EXIT_STOP_REQUESTED)
		requestStop(sb.paths, false)
	})
})
