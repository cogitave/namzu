import { NOOP_LOGGER } from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import { runNowCommand } from '../commands/lifecycle.js'
import { ScheduleDaemon } from '../daemon/daemon.js'
import { writeRunResult } from '../fire/result.js'
import { readHistory } from '../store/history.js'
import { updateJob } from '../store/jobs.js'
import { readState } from '../store/state.js'
import { type Sandbox, confirmedJob, recordingContext, sandbox } from './fixtures.js'

let box: Sandbox | undefined
afterEach(() => {
	box?.cleanup()
	box = undefined
})

function daemon(
	sb: Sandbox,
	options: Partial<ConstructorParameters<typeof ScheduleDaemon>[0]> = {},
) {
	return new ScheduleDaemon({
		paths: sb.paths,
		log: NOOP_LOGGER,
		version: 'test',
		epoch: crypto.randomUUID(),
		maxConcurrentRuns: 1,
		notifications: true,
		spawnFire: () => ({ exited: new Promise<number | null>(() => {}), terminate: () => {} }),
		notify: async () => {},
		fingerprint: () => 'same',
		watchJobs: false,
		...options,
	})
}

it('serializes child exit behind a tick holding the old active-run snapshot', async () => {
	const sb = sandbox()
	box = sb
	const clock = Date.parse('2026-09-23T03:00:01Z')
	const job = confirmedJob(sb, {}, new Date(clock - 60_000))
	let exit: (code: number | null) => void = () => {}
	let enteredNotice: () => void = () => {}
	let continueNotice: () => void = () => {}
	const noticeEntered = new Promise<void>((resolve) => {
		enteredNotice = resolve
	})
	const noticeGate = new Promise<void>((resolve) => {
		continueNotice = resolve
	})
	const d = daemon(sb, {
		now: () => clock,
		monotonic: () => clock,
		spawnFire: () => ({
			exited: new Promise<number | null>((resolve) => {
				exit = resolve
			}),
			terminate: () => {},
		}),
		notify: async () => {
			enteredNotice()
			await noticeGate
		},
	})
	await d.claimOwnership()
	try {
		await d.tick()
		const run = readState(sb.paths, job.id).activeRun
		expect(run).toBeDefined()
		updateJob(sb.paths, job.id, job.revision, (current) => ({
			...current,
			state: 'pending-confirmation',
		}))
		const ticking = d.tick()
		await noticeEntered
		writeRunResult(sb.paths, {
			v: 1,
			kind: 'schedule-run-result',
			jobId: job.id,
			runId: run?.runId as string,
			status: 'completed',
			exitCode: 0,
			startedAt: run?.startedAt as string,
			endedAt: new Date(clock).toISOString(),
		})
		exit(0)
		continueNotice()
		await ticking
		await d.settled()
		const state = readState(sb.paths, job.id)
		expect(state.activeRun).toBeUndefined()
		expect(state.lastRun?.runId).toBe(run?.runId)
		expect(state.counters.runs).toBe(1)
		expect(
			readHistory(sb.paths, job.id).filter(
				(record) =>
					record.kind === 'run' && record.runId === run?.runId && record.status === 'completed',
			),
		).toHaveLength(1)
	} finally {
		continueNotice()
		await d.releaseOwnership()
	}
})

it('refuses foreground run-now when a daemon owns the home but its endpoint is absent', async () => {
	const sb = sandbox()
	box = sb
	const job = confirmedJob(sb)
	const d = daemon(sb)
	await d.claimOwnership()
	try {
		const ctx = recordingContext()
		expect(await runNowCommand(ctx, [job.name, '--home', sb.home])).toBe(1)
		expect(ctx.out.errors).toEqual([
			expect.stringMatching(/scheduler owns this home but its command endpoint is unavailable/i),
		])
		expect(readState(sb.paths, job.id).activeRun).toBeUndefined()
		expect(readHistory(sb.paths, job.id).filter((record) => record.kind === 'run')).toEqual([])
	} finally {
		await d.releaseOwnership()
	}
})
