import { type ChildProcess, fork } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ResidentConflictError, type ResidentState } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { parseRunFlags } from '../../commands/run-flags.js'
import type { OwnedRunnerWorkerOptions } from './__fixtures__/owned-runner-worker.js'
import { queryRunner } from './runner-control.js'
import { startResidentRunner, stopResidentRunner } from './runner-launch.js'
import {
	finishRunner,
	readRunner,
	readRunnerInstance,
	releaseRunner,
	reserveRunner,
} from './runner-store.js'
import { type CliResident, createResident } from './storage.js'

const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx')
const WORKER = fileURLToPath(new URL('./__fixtures__/owned-runner-worker.ts', import.meta.url))
const roots: string[] = []
const residents: CliResident[] = []
type WorkerMessage = Readonly<Record<string, unknown>> & { readonly kind: string }
interface Worker {
	readonly child: ChildProcess
	readonly messages: WorkerMessage[]
	readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	waitFor(...kinds: string[]): Promise<WorkerMessage>
}
const workers: Worker[] = []

afterEach(async () => {
	// Stop any real detached worker even if its launcher's assertion failed.
	for (const resident of residents.splice(0)) {
		const owner = readRunner(resident)
		if (owner?.phase === 'running') {
			const stopped = await stopResidentRunner(resident, { owner, waitMs: 100 })
			if (stopped.status === 'unconfirmed' && owner.pid !== null) {
				// This PID was created only in this test's private NAMZU_HOME.
				try {
					process.kill(owner.pid, 'SIGKILL')
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
				}
			}
		}
	}
	await Promise.all(
		workers.splice(0).map(async (worker) => {
			if (worker.child.exitCode === null && worker.child.signalCode === null)
				worker.child.kill('SIGKILL')
			await worker.done
		}),
	)
	vi.unstubAllEnvs()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function snapshot(resident: CliResident) {
	const state = await resident.agenda.read()
	if (!state) throw new Error('Missing owned runner fixture agenda')
	return state
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-owned-runner-'))
	roots.push(root)
	const cwd = join(root, 'workspace')
	const stateRoot = join(root, 'home')
	await mkdir(cwd)
	await mkdir(stateRoot)
	vi.stubEnv('NAMZU_HOME', stateRoot)
	const resident = await createResident(cwd, 'default')
	residents.push(resident)
	return { root, cwd, resident }
}

function launch(
	f: Awaited<ReturnType<typeof fixture>>,
	mode: OwnedRunnerWorkerOptions['mode'],
): Worker {
	const child = fork(
		WORKER,
		[JSON.stringify({ cwd: f.cwd, mode, effectPath: join(f.root, 'effect.txt') })],
		{
			execArgv: ['--import', TSX_IMPORT],
			stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
		},
	)
	const messages: WorkerMessage[] = []
	const observers = new Set<() => void>()
	let stderr = ''
	let closed = false
	child.stderr?.on('data', (data) => {
		stderr += data
	})
	child.on('error', (error) => {
		stderr += error.message
	})
	child.on('message', (message) => {
		messages.push(message as WorkerMessage)
		for (const observer of observers) observer()
	})
	const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once('close', (code, signal) => {
			closed = true
			resolve({ code, signal })
			for (const observer of observers) observer()
		})
	})
	const worker: Worker = {
		child,
		messages,
		done,
		waitFor: (...kinds) =>
			new Promise((resolve, reject) => {
				const finish = (message?: WorkerMessage, error?: Error) => {
					clearTimeout(timer)
					observers.delete(observe)
					if (message) resolve(message)
					else reject(error)
				}
				const observe = () => {
					const message = messages.find((message) => kinds.includes(message.kind))
					if (message) finish(message)
					else if (closed)
						finish(undefined, new Error(`Worker exited before ${kinds.join('/')}: ${stderr}`))
				}
				const timer = setTimeout(
					() => finish(undefined, new Error(`Worker did not report ${kinds.join('/')}: ${stderr}`)),
					15_000,
				)
				observers.add(observe)
				observe()
			}),
	}
	workers.push(worker)
	return worker
}

async function start(worker: Worker) {
	await worker.waitFor('ready')
	worker.child.send('go')
}

it.each(['complete', 'indefinite'] as const)(
	'the actual detached worker survives its launcher and remains controllable with %s work and no provider calls',
	async (phase) => {
		const f = await fixture()
		const pursuit = await f.resident.agenda.add(
			await snapshot(f.resident),
			'Wait without provider work',
		)
		const execution = f.resident.agenda.execution(pursuit.id)
		await execution.settle(
			await execution.claim(pursuit.state, Date.now()),
			phase === 'complete'
				? { kind: 'complete', summary: 'Fixture already verified' }
				: { kind: 'wait', wakeAt: null, summary: 'Waiting for new evidence' },
			Date.now(),
		)
		const before = await snapshot(f.resident)
		const launcher = launch(f, 'launcher')
		await start(launcher)
		const launched = await launcher.waitFor('launched')
		expect(await launcher.done).toEqual({ code: 0, signal: null })
		const owner = readRunner(f.resident)
		if (!owner) throw new Error('Missing launched worker ownership')
		expect(launched).toMatchObject({ owner: { instanceId: owner.instanceId, phase: 'running' } })
		expect(owner.pid).not.toBe(launcher.child.pid)
		await sleep(75)
		expect(await queryRunner(owner, 'status')).toMatchObject({
			kind: 'responsive',
			phase: 'idle',
			stepsStarted: 0,
		})
		expect(await readdir(f.resident.artifactsRoot)).toEqual([])
		expect(await snapshot(f.resident)).toEqual(before)
		await f.resident.agenda.setPaused(before, true)
		expect(await stopResidentRunner(f.resident, { owner })).toMatchObject({
			status: 'drained',
			owner: { instanceId: owner.instanceId, phase: 'stopped', maxSteps: 2 },
		})
		expect(await readdir(f.resident.artifactsRoot)).toEqual([])
	},
	30_000,
)

it.each(['delayed', 'ready-delay'] as const)(
	'fences a %s startup after another process pauses and resumes admission',
	async (mode) => {
		const f = await fixture()
		await f.resident.agenda.add(await snapshot(f.resident), 'Must not execute under old authority')
		const worker = launch(f, mode)
		await start(worker)
		await worker.waitFor(mode === 'delayed' ? 'reserved' : 'attached')
		const paused = await f.resident.agenda.setPaused(await snapshot(f.resident), true)
		await f.resident.agenda.setPaused(paused, false)
		worker.child.send('release')
		const result = await worker.waitFor('result', 'failure')
		expect(result.calls).toBe(0)
		if (mode === 'delayed') {
			expect(result).toMatchObject({ kind: 'failure' })
			expect(String(result.message)).toContain('admission changed')
			expect(await worker.done).toEqual({ code: 1, signal: null })
		} else {
			expect(result).toMatchObject({ kind: 'result', result: { status: 'cancelled' } })
			expect(await worker.done).toEqual({ code: 0, signal: null })
		}
		expect(readRunner(f.resident)?.phase).toBe('stopped')
		expect((await snapshot(f.resident)).pursuits[0]?.state).toMatchObject({
			phase: 'waiting',
			stepsAdmitted: 0,
		})
	},
	30_000,
)

it('reserves one owner across racing processes even while both have no due work', async () => {
	const f = await fixture()
	const contenders = [launch(f, 'race'), launch(f, 'race')]
	await Promise.all(contenders.map(start))
	const results = await Promise.all(
		contenders.map((worker) => worker.waitFor('attached', 'failure')),
	)
	expect(results.map((result) => result.kind).sort()).toEqual(['attached', 'failure'])
	expect(results.find((result) => result.kind === 'failure')).toMatchObject({
		name: 'ResidentConflictError',
		calls: 0,
	})
	const owner = readRunner(f.resident)
	if (!owner) throw new Error('Missing winning owner')
	expect(await queryRunner(owner, 'status')).toMatchObject({ kind: 'responsive', stepsStarted: 0 })
	await f.resident.agenda.setPaused(await snapshot(f.resident), true)
	expect(await stopResidentRunner(f.resident, { owner })).toMatchObject({ status: 'drained' })
	const exits = await Promise.all(contenders.map((worker) => worker.done))
	expect(exits.map((exit) => exit.code).sort()).toEqual([0, 1])
	expect(exits.map((exit) => exit.signal)).toEqual([null, null])
}, 30_000)

it('keeps stop unconfirmed and ownership occupied until a non-cooperative callback drains', async () => {
	const f = await fixture()
	const pursuit = await f.resident.agenda.add(
		await snapshot(f.resident),
		'An uncertain tool effect',
	)
	const worker = launch(f, 'noncooperative')
	await start(worker)
	await worker.waitFor('entered')
	const owner = readRunner(f.resident)
	if (!owner) throw new Error('Missing working owner')
	await f.resident.agenda.setPaused(await snapshot(f.resident), true)
	expect(await stopResidentRunner(f.resident, { owner, waitMs: 25 })).toMatchObject({
		status: 'unconfirmed',
	})
	expect(await queryRunner(owner, 'status')).toMatchObject({
		kind: 'responsive',
		phase: 'stopping',
		stepsStarted: 1,
	})
	expect(readRunner(f.resident)).toEqual(owner)
	expect(worker.messages.some((message) => message.kind === 'drained')).toBe(false)
	expect(() =>
		reserveRunner(f.resident, { mode: 'background', maxSteps: 1, pauseGeneration: 1 }),
	).toThrow(ResidentConflictError)
	worker.child.send('release')
	expect(await worker.waitFor('drained')).toMatchObject({ aborted: true })
	expect(await worker.waitFor('result')).toMatchObject({
		calls: 1,
		result: { status: 'cancelled', stepsSettled: 0 },
	})
	expect(await worker.done).toEqual({ code: 0, signal: null })
	expect(await stopResidentRunner(f.resident, { owner, waitMs: 0 })).toMatchObject({
		status: 'drained',
	})
	expect(await f.resident.agenda.execution(pursuit.id).read()).toMatchObject({
		phase: 'running',
		stepsAdmitted: 1,
	})
}, 30_000)

it('a delayed stop of a captured owner does not stop its live successor', async () => {
	const f = await fixture()
	const first = launch(f, 'race')
	await start(first)
	await first.waitFor('attached')
	const original = readRunner(f.resident)
	if (!original) throw new Error('Missing original owner')
	const paused = await f.resident.agenda.setPaused(await snapshot(f.resident), true)
	expect(await stopResidentRunner(f.resident, { owner: original })).toMatchObject({
		status: 'drained',
	})
	expect(await first.done).toEqual({ code: 0, signal: null })
	await f.resident.agenda.setPaused(paused, false)
	const next = launch(f, 'race')
	await start(next)
	await next.waitFor('attached')
	const successor = readRunner(f.resident)
	if (!successor) throw new Error('Missing successor owner')
	expect(successor.instanceId).not.toBe(original.instanceId)
	expect(await stopResidentRunner(f.resident, { owner: original, waitMs: 0 })).toMatchObject({
		status: 'drained',
		owner: { instanceId: original.instanceId },
	})
	expect(readRunner(f.resident)).toEqual(successor)
	expect(await queryRunner(successor, 'status')).toMatchObject({
		kind: 'responsive',
		phase: 'idle',
		stepsStarted: 0,
		stopRequested: false,
	})
	await f.resident.agenda.setPaused(await snapshot(f.resident), true)
	expect(await stopResidentRunner(f.resident, { owner: successor })).toMatchObject({
		status: 'drained',
	})
	expect(await next.done).toEqual({ code: 0, signal: null })
}, 30_000)

it.each(['cleanup-failed', 'cleanup-after-stop'] as const)(
	'retains ownership when %s cannot certify callback drainage',
	async (mode) => {
		const f = await fixture()
		const pursuit = await f.resident.agenda.add(
			await snapshot(f.resident),
			'Own an undrained resource',
		)
		const worker = launch(f, mode)
		await start(worker)
		await worker.waitFor('entered')
		const owner = readRunner(f.resident)
		if (!owner) throw new Error('Missing undrained owner')
		if (mode === 'cleanup-after-stop') {
			await f.resident.agenda.setPaused(await snapshot(f.resident), true)
			expect(await stopResidentRunner(f.resident, { owner, waitMs: 25 })).toMatchObject({
				status: 'unconfirmed',
			})
			worker.child.send('release')
			expect(await worker.waitFor('result')).toMatchObject({
				calls: 1,
				result: { status: 'cancelled', stepsSettled: 0 },
			})
			expect(await worker.done).toEqual({ code: 0, signal: null })
		} else {
			expect(await worker.waitFor('failure')).toMatchObject({
				name: 'ResidentCleanupUnconfirmedError',
				calls: 1,
			})
			expect(await worker.done).toEqual({ code: 1, signal: null })
		}
		expect(readRunner(f.resident)).toEqual(owner)
		expect(owner.phase).toBe('running')
		expect(await stopResidentRunner(f.resident, { owner, waitMs: 0 })).toMatchObject({
			status: 'unconfirmed',
		})
		expect(await queryRunner(owner, 'status')).toMatchObject({ kind: 'unresponsive' })
		expect(() =>
			reserveRunner(f.resident, { mode: 'background', maxSteps: 1, pauseGeneration: 0 }),
		).toThrow(ResidentConflictError)
		expect(await f.resident.agenda.execution(pursuit.id).read()).toMatchObject({
			phase: 'running',
			stepsAdmitted: 1,
		})
		releaseRunner(f.resident, owner)
	},
	30_000,
)

it.each(['reserved', 'effect'] as const)(
	'SIGKILL preserves %s ownership, prevents takeover and fences old releases after explicit recovery',
	async (mode) => {
		const f = await fixture()
		if (mode === 'effect')
			await f.resident.agenda.add(await snapshot(f.resident), 'Apply a fixture file effect')
		const worker = launch(f, mode)
		await start(worker)
		const message = await worker.waitFor(mode === 'effect' ? 'effect' : 'reserved')
		const original = readRunner(f.resident)
		if (!original) throw new Error('Missing interrupted owner')
		expect(worker.child.kill('SIGKILL')).toBe(true)
		expect(await worker.done).toEqual({ code: null, signal: 'SIGKILL' })
		expect(readRunner(f.resident)).toEqual(original)
		expect(await stopResidentRunner(f.resident, { owner: original, waitMs: 0 })).toMatchObject({
			status: 'unconfirmed',
		})
		expect(() =>
			reserveRunner(f.resident, { mode: 'background', maxSteps: 1, pauseGeneration: 0 }),
		).toThrow(ResidentConflictError)
		const released = releaseRunner(f.resident, original)
		expect(released.phase).toBe('released')
		if (mode === 'effect') {
			const claim = message.claim as ResidentState
			const execution = f.resident.agenda.execution(claim.pursuitId!)
			expect(await execution.read()).toEqual(claim)
			await expect(
				startResidentRunner({
					resident: f.resident,
					ctx: { config: {}, formatter: { name: 'json', print() {}, info() {}, error() {} } },
					flags: parseRunFlags([]),
					maxSteps: 1,
					maxIdleMs: 25,
				}),
			).rejects.toThrow('unresolved')
			expect(await readFile(join(f.root, 'effect.txt'), 'utf8')).toBe('applied once')
			await execution.settle(
				claim,
				{ kind: 'complete', summary: 'Verified the file effect after executor exit' },
				Date.now(),
			)
		}
		const successor = reserveRunner(f.resident, {
			mode: 'background',
			maxSteps: 1,
			pauseGeneration: 0,
		})
		expect(successor.instanceId).not.toBe(original.instanceId)
		expect(() => releaseRunner(f.resident, original)).toThrow(ResidentConflictError)
		expect(() => finishRunner(f.resident, original, 'late stopped acknowledgement')).toThrow(
			ResidentConflictError,
		)
		expect(readRunner(f.resident)).toEqual(successor)
		expect(readRunnerInstance(f.resident, original.instanceId)).toEqual(released)
		finishRunner(f.resident, successor, 'Fixture reservation never started')
	},
	30_000,
)
