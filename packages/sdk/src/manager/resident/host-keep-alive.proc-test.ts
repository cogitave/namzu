import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'

const WORKER = fileURLToPath(new URL('./__tests__/keep-alive-worker.mjs', import.meta.url))
const roots: string[] = []
type WorkerMessage = Readonly<Record<string, unknown>> & { readonly kind: string }
interface Worker {
	readonly child: ChildProcess
	readonly messages: WorkerMessage[]
	readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
	waitFor(kind: string, calls?: number): Promise<WorkerMessage>
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
	if (!state) throw new Error('Missing keep-alive process agenda')
	return state
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-keep-alive-process-'))
	roots.push(root)
	const tenantId = generateTenantId()
	const agenda = new DiskResidentAgenda(root, { tenantId, agentKey: 'keep-alive-process' })
	await agenda.create('Careful resident')
	return { root, tenantId, agenda }
}

function launch(f: Awaited<ReturnType<typeof fixture>>, mode = 'normal'): Worker {
	const child = spawn(process.execPath, [WORKER, f.root, f.tenantId, mode], {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const messages: WorkerMessage[] = []
	const observers = new Set<() => void>()
	let stdout = ''
	let stderr = ''
	let closed = false
	child.stderr?.on('data', (data) => {
		stderr += data
	})
	child.on('error', (error) => {
		stderr += error.message
	})
	child.stdout?.on('data', (data) => {
		stdout += data
		let end = stdout.indexOf('\n')
		while (end !== -1) {
			messages.push(JSON.parse(stdout.slice(0, end)) as WorkerMessage)
			stdout = stdout.slice(end + 1)
			end = stdout.indexOf('\n')
		}
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
		waitFor: (kind, calls) =>
			new Promise((resolve, reject) => {
				const finish = (message?: WorkerMessage, error?: Error) => {
					clearTimeout(timer)
					observers.delete(observe)
					if (message) resolve(message)
					else reject(error)
				}
				const observe = () => {
					const message = messages.find(
						(message) => message.kind === kind && (calls === undefined || message.calls === calls),
					)
					if (message) finish(message)
					else if (closed) finish(undefined, new Error(`Worker exited before ${kind}: ${stderr}`))
				}
				const timer = setTimeout(
					() => finish(undefined, new Error(`Worker did not report ${kind}: ${stderr}`)),
					15_000,
				)
				observers.add(observe)
				observe()
			}),
	}
	workers.push(worker)
	return worker
}

it('keeps its own process alive across empty and indefinite waits without resetting the step cap', async () => {
	const f = await fixture()
	const worker = launch(f)
	expect(await worker.waitFor('idle', 0)).toMatchObject({ calls: 0 })
	expect(worker.child.exitCode).toBeNull()
	const pursuit = await f.agenda.add(await snapshot(f.agenda), 'Inspect added evidence')
	expect(await worker.waitFor('idle', 1)).toMatchObject({ calls: 1 })
	const waiting = (await snapshot(f.agenda)).pursuits[0]
	if (!waiting) throw new Error('Missing waiting pursuit')
	expect(waiting.state).toMatchObject({
		phase: 'waiting',
		wakeAt: null,
		stepsAdmitted: 1,
		summary: 'First observation retained',
	})
	await f.agenda.wake(pursuit.id, waiting.state, 'Further evidence arrived', Date.now())
	expect(await worker.waitFor('result')).toMatchObject({
		calls: 2,
		result: { status: 'limit', stepsSettled: 2 },
	})
	expect(await worker.done).toEqual({ code: 0, signal: null })
	expect((await snapshot(f.agenda)).pursuits[0]?.state).toMatchObject({
		phase: 'complete',
		stepsAdmitted: 2,
	})
	const next = await f.agenda.add(await snapshot(f.agenda), 'Requires a new authorized invocation')
	expect(next.state.stepsAdmitted).toBe(0)
}, 30_000)

it('aborts its idle process without callbacks or admitted work', async () => {
	const f = await fixture()
	const worker = launch(f)
	await worker.waitFor('idle', 0)
	expect(worker.child.kill('SIGTERM')).toBe(true)
	expect(await worker.waitFor('result')).toMatchObject({
		calls: 0,
		result: { status: 'cancelled', stepsSettled: 0 },
	})
	expect(await worker.done).toEqual({ code: 0, signal: null })
	expect((await snapshot(f.agenda)).pursuits).toEqual([])
}, 30_000)

it('drains interrupted work before its process exits and retains the unresolved claim', async () => {
	const f = await fixture()
	const pursuit = await f.agenda.add(await snapshot(f.agenda), 'A cancellable fixture effect')
	const worker = launch(f, 'abort')
	await worker.waitFor('entered', 1)
	expect(worker.child.kill('SIGTERM')).toBe(true)
	expect(await worker.waitFor('drained')).toMatchObject({ aborted: true })
	expect(await worker.waitFor('result')).toMatchObject({
		calls: 1,
		result: { status: 'cancelled', stepsSettled: 0 },
	})
	expect(await worker.done).toEqual({ code: 0, signal: null })
	expect(worker.messages.map((message) => message.kind)).toEqual(['entered', 'drained', 'result'])
	expect(await f.agenda.execution(pursuit.id).read()).toMatchObject({
		phase: 'running',
		stepsAdmitted: 1,
	})
}, 30_000)
