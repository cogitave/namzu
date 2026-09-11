import { type ChildProcess, fork } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { ResidentHost } from './host.js'
import { stepResident } from './loop.js'
import { ResidentConflictError } from './store.js'

function receive(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const onExit = () => {
			cleanup()
			reject(new Error('Agenda worker exited before reporting.'))
		}
		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}
		const onMessage = (message: unknown) => {
			cleanup()
			resolve(message)
		}
		const cleanup = () => {
			child.off('exit', onExit)
			child.off('error', onError)
			child.off('message', onMessage)
		}
		child.once('exit', onExit)
		child.once('error', onError)
		child.once('message', onMessage)
	})
}

it('admits one process across different pursuits and preserves its unresolved ownership on reopen', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-agenda-proc-'))
	const scope = { tenantId: generateTenantId(), agentKey: 'agenda-process-check' }
	const agenda = new DiskResidentAgenda(root, scope)
	const workers: ChildProcess[] = []
	try {
		const initial = await agenda.create('One resident with two independent pursuits')
		const first = await agenda.add(initial, 'Review the first document.')
		const afterFirst = await agenda.read()
		if (!afterFirst) throw new Error('Created agenda is missing.')
		const second = await agenda.add(afterFirst, 'Review the second document.')
		const pursuits = [first, second]
		const ready = pursuits.map((pursuit) => {
			const worker = fork(
				fileURLToPath(new URL('./__tests__/agenda-worker.mjs', import.meta.url)),
				[root, scope.tenantId, pursuit.id],
				{ execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
			)
			workers.push(worker)
			return receive(worker)
		})
		// Both processes must observe their own waiting pursuit before either may claim it.
		expect(await Promise.all(ready)).toEqual(
			pursuits.map((pursuit) => ({ ready: pursuit.id, phase: 'waiting' })),
		)
		const exits = workers.map(
			(worker) =>
				new Promise<number | null>((resolve) => worker.once('exit', (code) => resolve(code))),
		)
		const outcomes = workers.map((worker) => receive(worker))
		for (const worker of workers) worker.send('go')
		expect((await Promise.all(outcomes)).sort()).toEqual(['ResidentConflictError', 'claimed'])
		expect(await Promise.all(exits)).toEqual([0, 0])

		const snapshot = await agenda.read()
		if (!snapshot) throw new Error('Claimed agenda is missing.')
		expect(snapshot.pursuits.map((pursuit) => pursuit.state.phase).sort()).toEqual([
			'running',
			'waiting',
		])
		expect(
			snapshot.pursuits.reduce((total, pursuit) => total + pursuit.state.stepsAdmitted, 0),
		).toBe(1)

		const reopened = new DiskResidentAgenda(root, scope)
		expect(await reopened.read()).toEqual(snapshot)
		const callback = vi.fn()
		const results = await Promise.all(
			pursuits.map((pursuit) =>
				stepResident(reopened.execution(pursuit.id), callback, new AbortController().signal),
			),
		)
		expect(results.map((result) => result.status)).toEqual(['idle', 'idle'])
		expect(results.map((result) => (result.status === 'idle' ? result.reason : '')).sort()).toEqual(
			['contended', 'unresolved'],
		)
		expect(callback).not.toHaveBeenCalled()
		expect(await reopened.read()).toEqual(snapshot)
	} finally {
		await Promise.all(
			workers.map(async (worker) => {
				if (worker.exitCode !== null || worker.signalCode !== null) return
				const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
				worker.kill()
				await exited
			}),
		)
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)

it('does not repeat an effect after a worker is killed before settlement', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-agenda-kill-'))
	const scope = { tenantId: generateTenantId(), agentKey: 'agenda-process-check' }
	let worker: ChildProcess | undefined
	try {
		const agenda = new DiskResidentAgenda(root, scope)
		const pursuit = await agenda.add(await agenda.create('Careful executor'), 'Apply one effect')
		worker = fork(
			fileURLToPath(new URL('./__tests__/agenda-worker.mjs', import.meta.url)),
			[root, scope.tenantId, pursuit.id, 'effect'],
			{ execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
		)
		await receive(worker)
		const effect = receive(worker)
		worker.send('go')
		expect(await effect).toBe('effect-applied')
		const exited = new Promise<void>((resolve) => worker?.once('exit', () => resolve()))
		worker.kill('SIGKILL')
		await exited
		const reopened = new DiskResidentAgenda(root, scope)
		const callback = vi.fn()
		expect(
			await new ResidentHost(reopened, callback).run({
				signal: new AbortController().signal,
				maxSteps: 1,
			}),
		).toMatchObject({ status: 'unresolved', stepsSettled: 0 })
		expect(callback).not.toHaveBeenCalled()
		const execution = reopened.execution(pursuit.id)
		const uncertain = await execution.read()
		if (!uncertain) throw new Error('Missing killed pursuit')
		expect(uncertain.phase).toBe('running')
		// Executor has exited; host inspects the effect before reconciling.
		expect(await readFile(join(root, 'effect.txt'), 'utf8')).toBe('applied once')
		await execution.settle(
			uncertain,
			{ kind: 'complete', summary: 'Host verified the saved effect' },
			Date.now(),
		)
		await expect(
			execution.settle(uncertain, { kind: 'complete', summary: 'Stale result' }, Date.now()),
		).rejects.toBeInstanceOf(ResidentConflictError)
		expect(
			await new ResidentHost(reopened, callback).run({
				signal: new AbortController().signal,
				maxSteps: 1,
			}),
		).toMatchObject({ status: 'idle', stepsSettled: 0 })
		expect(callback).not.toHaveBeenCalled()
	} finally {
		if (worker && worker.exitCode === null && worker.signalCode === null) {
			const child = worker
			const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
			child.kill('SIGKILL')
			await exited
		}
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)
