import { type ChildProcess, fork } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	DiskResidentAgenda,
	ResidentConflictError,
	type ResidentState,
	generateTenantId,
} from '@namzu/sdk'
import { afterEach, expect, it } from 'vitest'
import type { ForegroundWorkerOptions } from './__fixtures__/foreground-worker.js'

const TSX_IMPORT = createRequire(import.meta.url).resolve('tsx')
const WORKER = fileURLToPath(new URL('./__fixtures__/foreground-worker.ts', import.meta.url))
const roots: string[] = []
type WorkerMessage = Readonly<Record<string, unknown>> & { readonly kind: string }
interface Worker {
	readonly child: ChildProcess
	readonly messages: WorkerMessage[]
	readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	waitFor(...kinds: string[]): Promise<WorkerMessage>
}
const workers: Worker[] = []

afterEach(async () => {
	await Promise.all(
		workers.splice(0).map(async (worker) => {
			if (worker.child.exitCode === null && worker.child.signalCode === null)
				worker.child.kill('SIGKILL')
			await worker.done
		}),
	)
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function snapshot(agenda: DiskResidentAgenda) {
	const state = await agenda.read()
	if (!state) throw new Error('Missing foreground agenda')
	return state
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-foreground-process-'))
	roots.push(root)
	const tenantId = generateTenantId()
	const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'foreground-process' })
	const pursuit = await agenda.add(await agenda.create('Careful resident'), 'Apply one effect')
	return { root, tenantId, agenda, pursuit }
}

function launch(
	f: Awaited<ReturnType<typeof fixture>>,
	options: Omit<ForegroundWorkerOptions, 'root' | 'tenantId'>,
): Worker {
	const child = fork(WORKER, [JSON.stringify({ root: f.root, tenantId: f.tenantId, ...options })], {
		execArgv: ['--import', TSX_IMPORT],
		stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
	})
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

async function control(
	f: Awaited<ReturnType<typeof fixture>>,
	request: ForegroundWorkerOptions['control'],
) {
	const worker = launch(f, { mode: 'control', control: request })
	await start(worker)
	const result = await worker.waitFor('controlled')
	expect(await worker.done).toEqual({ code: 0, signal: null })
	return result
}

async function runOnce(f: Awaited<ReturnType<typeof fixture>>) {
	const worker = launch(f, { mode: 'run' })
	await start(worker)
	const result = await worker.waitFor('result')
	expect(await worker.done).toEqual({ code: 0, signal: null })
	return result
}

it('ends an old idle invocation when pause and resume both precede its next control read', async () => {
	const f = await fixture()
	const execution = f.agenda.execution(f.pursuit.id)
	const waiting = await execution.settle(
		await execution.claim(f.pursuit.state, Date.now()),
		{ kind: 'wait', wakeAt: Date.now() + 45_000, summary: 'Waiting for fresh evidence' },
		Date.now(),
	)
	const worker = launch(f, { mode: 'idle' })
	await start(worker)
	await worker.waitFor('control-waiting')
	expect(await control(f, 'pause-resume')).toMatchObject({ paused: false, generation: 1 })
	worker.child.send('release')
	expect(await worker.waitFor('result')).toMatchObject({
		calls: 0,
		result: { status: 'cancelled', stepsSettled: 0 },
	})
	expect(await worker.done).toEqual({ code: 0, signal: null })
	expect(await execution.read()).toEqual(waiting)
}, 30_000)

it('delivers a remote pause to the active callback and drains before preserving its unresolved claim', async () => {
	const f = await fixture()
	const worker = launch(f, { mode: 'cooperative' })
	await start(worker)
	await worker.waitFor('entered')
	expect(await control(f, 'pause')).toMatchObject({ paused: true, generation: 1 })
	expect(await worker.waitFor('drained')).toMatchObject({ aborted: true })
	expect(await worker.waitFor('result')).toMatchObject({
		calls: 1,
		result: { status: 'cancelled', stepsSettled: 0 },
	})
	expect(await worker.done).toEqual({ code: 0, signal: null })
	expect(worker.messages.map((message) => message.kind).slice(-2)).toEqual(['drained', 'result'])
	const unresolved = await f.agenda.execution(f.pursuit.id).read()
	expect(unresolved).toMatchObject({ phase: 'running', stepsAdmitted: 1 })
	await control(f, 'resume')
	expect(await runOnce(f)).toMatchObject({
		calls: 0,
		result: { status: 'unresolved', stepsSettled: 0 },
	})
	expect(await f.agenda.execution(f.pursuit.id).read()).toEqual(unresolved)
}, 30_000)

it('admits only one of two process owners selecting different pursuits', async () => {
	const f = await fixture()
	const second = await f.agenda.add(await snapshot(f.agenda), 'Another independent pursuit')
	const contenders = [f.pursuit, second].map((pursuit) =>
		launch(f, { mode: 'cooperative', pursuitId: pursuit.id }),
	)
	await Promise.all(contenders.map(start))
	await Promise.all(contenders.map((worker) => worker.waitFor('admission-ready')))
	for (const worker of contenders) worker.child.send('release')
	const outcomes = await Promise.all(
		contenders.map((worker) => worker.waitFor('entered', 'result')),
	)
	expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['entered', 'result'])
	expect(outcomes.find((outcome) => outcome.kind === 'result')).toMatchObject({
		calls: 0,
		result: { status: 'contended', stepsSettled: 0 },
	})
	const current = await snapshot(f.agenda)
	expect(current.pursuits.map((pursuit) => pursuit.state.phase).sort()).toEqual([
		'running',
		'waiting',
	])
	expect(current.pursuits.reduce((total, pursuit) => total + pursuit.state.stepsAdmitted, 0)).toBe(
		1,
	)
	await control(f, 'pause')
	await Promise.all(contenders.map((worker) => worker.waitFor('result')))
	for (const worker of contenders) expect(await worker.done).toEqual({ code: 0, signal: null })
}, 30_000)

it('never replays an effect after SIGKILL and requires the exact saved claim for reconciliation', async () => {
	const f = await fixture()
	const worker = launch(f, { mode: 'effect' })
	await start(worker)
	const effect = await worker.waitFor('effect')
	const claim = effect.claim as ResidentState
	expect(worker.child.kill('SIGKILL')).toBe(true)
	expect(await worker.done).toEqual({ code: null, signal: 'SIGKILL' })
	expect(await runOnce(f)).toMatchObject({
		calls: 0,
		result: { status: 'unresolved', stepsSettled: 0 },
	})
	const execution = f.agenda.execution(f.pursuit.id)
	expect(await execution.read()).toEqual(claim)
	expect(await readFile(join(f.root, 'effect.txt'), 'utf8')).toBe('applied once')
	await execution.settle(
		claim,
		{ kind: 'complete', summary: 'Inspected the saved file effect' },
		Date.now(),
	)
	await expect(
		execution.settle(claim, { kind: 'complete', summary: 'Late pre-recovery result' }, Date.now()),
	).rejects.toBeInstanceOf(ResidentConflictError)
	expect(await runOnce(f)).toMatchObject({
		calls: 0,
		result: { status: 'idle', stepsSettled: 0 },
	})
	expect(await readFile(join(f.root, 'effect.txt'), 'utf8')).toBe('applied once')
}, 30_000)

it('stops and drains an executor when persisted control state becomes unreadable', async () => {
	const f = await fixture()
	const worker = launch(f, { mode: 'cooperative' })
	await start(worker)
	await worker.waitFor('entered')
	const before = await snapshot(f.agenda)
	const path = join(
		f.root,
		f.tenantId,
		'foreground-process',
		'agenda',
		'revisions',
		`${before.revision}.json`,
	)
	const raw = await readFile(path, 'utf8')
	await writeFile(path, '{incomplete-json')
	expect(await worker.waitFor('drained')).toMatchObject({ aborted: true })
	expect(await worker.waitFor('failure')).toHaveProperty('message')
	expect(await worker.done).toEqual({ code: 1, signal: null })
	expect(worker.messages.some((message) => message.kind === 'result')).toBe(false)
	await writeFile(path, raw)
	expect(await snapshot(f.agenda)).toEqual(before)
	expect(before.pursuits[0]?.state).toMatchObject({ phase: 'running', stepsAdmitted: 1 })
}, 30_000)
