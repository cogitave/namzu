import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { ResidentHost, type ResidentPursuitStep } from './host.js'
import { stepResident } from './loop.js'
import { ResidentConflictError } from './store.js'

const roots: string[] = []
const signal = new AbortController().signal
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-host-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'resident-host' }
	const agenda = new DiskResidentAgenda(root, scope)
	await agenda.create('Careful researcher')
	return { agenda, reopen: () => new DiskResidentAgenda(root, scope) }
}
async function snapshot(agenda: DiskResidentAgenda) {
	const state = await agenda.read()
	if (!state) throw new Error('Missing agenda fixture')
	return state
}

it('retains separate pursuit outcomes and selects less-served due work before a continuation', async () => {
	const f = await fixture()
	const a = await f.agenda.add(await snapshot(f.agenda), 'First question')
	const b = await f.agenda.add(await snapshot(f.agenda), 'Second question')
	const [first, second] = a.id.localeCompare(b.id) < 0 ? [a, b] : [b, a]
	const order: string[] = []
	const host = new ResidentHost(f.agenda, async ({ id, state }) => {
		order.push(id)
		expect(state.identity).toBe('Careful researcher')
		if (id === first.id && state.stepsAdmitted === 1)
			return { kind: 'wait', wakeAt: Date.now() + 60_000, summary: 'First draft' }
		if (id === second.id) await host.wake(first.id, 'Revision now useful')
		if (state.stepsAdmitted === 2) expect(state.summary).toBe('First draft')
		return { kind: 'complete', summary: state.objective }
	})
	expect(await host.run({ signal, maxSteps: 4 })).toMatchObject({ status: 'idle', stepsSettled: 3 })
	expect(order).toEqual([first.id, second.id, first.id])
	expect((await snapshot(f.reopen())).pursuits.map((p) => p.state.summary)).toEqual([
		'First question',
		'Second question',
	])
	const idle = vi.fn()
	expect(await new ResidentHost(f.reopen(), idle).run({ signal, maxSteps: 2 })).toMatchObject({
		status: 'idle',
		stepsSettled: 0,
	})
	expect(idle).not.toHaveBeenCalled()
})

it('keeps pause durable across reopen and only resumes on explicit host authorization', async () => {
	const f = await fixture()
	const pursuit = await f.agenda.add(await snapshot(f.agenda), 'One task')
	const step = vi.fn<ResidentPursuitStep>(async () => ({ kind: 'complete', summary: 'Done' }))
	await new ResidentHost(f.agenda, step).pause()
	const reopened = new ResidentHost(f.reopen(), step)
	expect(await reopened.run({ signal, maxSteps: 1 })).toMatchObject({
		status: 'paused',
		stepsSettled: 0,
	})
	await expect(
		f.agenda.execution(pursuit.id).claim(pursuit.state, Date.now()),
	).rejects.toBeInstanceOf(ResidentConflictError)
	expect(step).not.toHaveBeenCalled()
	await reopened.resume()
	expect(step).not.toHaveBeenCalled()
	expect(await reopened.run({ signal, maxSteps: 1 })).toMatchObject({
		status: 'limit',
		stepsSettled: 1,
	})
	expect(step).toHaveBeenCalledTimes(1)
})

it('interrupts a real idle timer on wake and handles a wake delivered during its state read', async () => {
	for (const duringRead of [false, true]) {
		const f = await fixture()
		const pursuit = await f.agenda.add(await snapshot(f.agenda), 'Waiting for evidence')
		const execution = f.agenda.execution(pursuit.id)
		await execution.settle(
			await execution.claim(pursuit.state, Date.now()),
			{
				kind: 'wait',
				wakeAt: Date.now() + 60_000,
				summary: 'No new evidence',
			},
			Date.now(),
		)
		const observed = deferred()
		const releaseRead = deferred()
		const original = f.agenda.read.bind(f.agenda)
		vi.spyOn(f.agenda, 'read').mockImplementationOnce(async () => {
			const state = await original()
			observed.resolve()
			if (duringRead) await releaseRead.promise
			return state
		})
		const step = vi.fn<ResidentPursuitStep>(async ({ state }) => {
			expect(state.reason).toBe('New evidence')
			return { kind: 'complete', summary: 'Processed evidence' }
		})
		const host = new ResidentHost(f.agenda, step)
		const pending = host.run({ signal, maxSteps: 1 })
		await observed.promise
		if (!duringRead) await new Promise<void>((resolve) => setImmediate(resolve))
		await host.wake(pursuit.id, 'New evidence')
		releaseRead.resolve()
		expect(await pending).toMatchObject({ status: 'limit', stepsSettled: 1 })
		expect(step).toHaveBeenCalledTimes(1)
	}
})

it.each([false, true])(
	'pause drains active work without replaying uncertain effects, keepAlive=%s',
	async (keepAlive) => {
		const f = await fixture()
		const pursuit = await f.agenda.add(await snapshot(f.agenda), 'An effectful task')
		const entered = deferred()
		const release = deferred()
		let callbackSignal: AbortSignal | undefined
		const host = new ResidentHost(f.agenda, async (_pursuit, abort) => {
			callbackSignal = abort
			entered.resolve()
			await release.promise // Deliberately non-cooperative executor.
			return { kind: 'complete', summary: 'Effect may have happened' }
		})
		let drained = false
		const pending = host.run({ signal, maxSteps: 2, keepAlive }).then((result) => {
			drained = true
			return result
		})
		await entered.promise
		expect(() => host.run({ signal, maxSteps: 1 })).toThrow('already active')
		await host.pause()
		expect(callbackSignal?.aborted).toBe(true)
		expect(drained).toBe(false)
		await expect(host.resume()).rejects.toThrow('drain')
		const competingStep = vi.fn()
		const other = new ResidentHost(f.reopen(), competingStep)
		await other.resume()
		expect(await other.run({ signal, maxSteps: 1 })).toMatchObject({ status: 'unresolved' })
		expect(competingStep).not.toHaveBeenCalled()
		release.resolve()
		expect(await pending).toMatchObject({ status: 'cancelled', stepsSettled: 0 })
		const execution = f.reopen().execution(pursuit.id)
		const uncertain = await execution.read()
		if (!uncertain) throw new Error('Missing interrupted pursuit')
		expect(uncertain.phase).toBe('running')
		// Only after executor drain + host inspection may the saved claim be reconciled.
		await execution.settle(
			uncertain,
			{ kind: 'complete', summary: 'Host verified effect' },
			Date.now(),
		)
		await expect(
			execution.settle(uncertain, { kind: 'complete', summary: 'Late stale result' }, Date.now()),
		).rejects.toBeInstanceOf(ResidentConflictError)
		expect(await other.run({ signal, maxSteps: 1 })).toMatchObject({
			status: 'idle',
			stepsSettled: 0,
		})
	},
)

it('cancels an idle host without admitting work and preserves the future wake on restart', async () => {
	const f = await fixture()
	const pursuit = await f.agenda.add(await snapshot(f.agenda), 'Later task')
	const execution = f.agenda.execution(pursuit.id)
	await execution.settle(
		await execution.claim(pursuit.state, Date.now()),
		{ kind: 'wait', wakeAt: Date.now() + 60_000, summary: 'Later' },
		Date.now(),
	)
	const before = await execution.read()
	const read = f.agenda.read.bind(f.agenda)
	const observed = deferred()
	vi.spyOn(f.agenda, 'read').mockImplementation(async () => {
		const value = await read()
		observed.resolve()
		return value
	})
	const step = vi.fn()
	const host = new ResidentHost(f.agenda, step)
	const pending = host.run({ signal, maxSteps: 1 })
	await observed.promise
	await new Promise<void>((resolve) => setImmediate(resolve))
	await host.pause()
	expect(await pending).toMatchObject({ status: 'cancelled', stepsSettled: 0 })
	expect(await f.reopen().execution(pursuit.id).read()).toEqual(before)
	const restarted = new ResidentHost(f.reopen(), step)
	await restarted.resume()
	expect(await restarted.run({ signal, maxSteps: 1, maxIdleMs: 0 })).toMatchObject({
		status: 'idle',
		nextWakeAt: before?.wakeAt,
	})
	expect(step).not.toHaveBeenCalled()
})

it('rejects foreign pursuit snapshots, stale agenda writes and additions beyond its bound', async () => {
	const f = await fixture()
	const initial = await snapshot(f.agenda)
	const first = await f.agenda.add(initial, 'First')
	await expect(f.agenda.add(initial, 'Stale')).rejects.toBeInstanceOf(ResidentConflictError)
	const second = await f.agenda.add(await snapshot(f.agenda), 'Second')
	await expect(f.agenda.execution(second.id).claim(first.state, Date.now())).rejects.toBeInstanceOf(
		ResidentConflictError,
	)
	for (let n = 2; n < 32; n++) await f.agenda.add(await snapshot(f.agenda), `Task ${n}`)
	const full = await snapshot(f.agenda)
	await expect(f.agenda.add(full, 'Overflow')).rejects.toThrow()
	expect(await snapshot(f.reopen())).toEqual(full)
})

it('never starts callbacks for invalid limits or a pre-aborted invocation', async () => {
	const f = await fixture()
	await f.agenda.add(await snapshot(f.agenda), 'First')
	const step = vi.fn()
	const host = new ResidentHost(f.agenda, step)
	expect(() => host.run({ signal, maxSteps: Number.POSITIVE_INFINITY })).toThrow('limits')
	expect(() => host.run({ signal, maxSteps: 1, maxIdleMs: -1 })).toThrow('limits')
	expect(() => host.run({ signal, maxSteps: 1, maxIdleMs: 0, keepAlive: true })).toThrow('limits')
	expect(() => host.run({ signal, maxSteps: 1, keepAlive: 'true' as unknown as boolean })).toThrow(
		'boolean',
	)
	expect(await host.run({ signal: AbortSignal.abort(), maxSteps: 1 })).toMatchObject({
		status: 'cancelled',
		stepsSettled: 0,
	})
	expect(step).not.toHaveBeenCalled()
	expect((await snapshot(f.agenda)).pursuits[0]?.state.stepsAdmitted).toBe(0)
})

it('settles after an unrelated write races its snapshot without rerunning the callback', async () => {
	const f = await fixture()
	const first = await f.agenda.add(await snapshot(f.agenda), 'Effectful work')
	const second = await f.agenda.add(await snapshot(f.agenda), 'Other work')
	const original = f.agenda.read.bind(f.agenda)
	const step = vi.fn(async () => {
		// The next agenda read is settlement. Advance another pursuit after that
		// snapshot has been read, before it can become the CAS precondition.
		vi.spyOn(f.agenda, 'read').mockImplementationOnce(async () => {
			const state = await original()
			await f.reopen().wake(second.id, second.state, 'Unrelated evidence', Date.now())
			return state
		})
		return { kind: 'complete' as const, summary: 'Effect verified once' }
	})
	expect(await stepResident(f.agenda.execution(first.id), step, signal)).toMatchObject({
		status: 'settled',
		state: { phase: 'complete' },
	})
	expect(step).toHaveBeenCalledTimes(1)
	expect((await snapshot(f.reopen())).pursuits[1]?.state.reason).toBe('Unrelated evidence')
})

it('blocks new invocations during durable pause and serializes a pause behind pending resume', async () => {
	for (const resumeFirst of [false, true]) {
		const f = await fixture()
		await f.agenda.add(await snapshot(f.agenda), 'Work')
		const host = new ResidentHost(f.agenda, vi.fn())
		if (resumeFirst) await host.pause()
		const entered = deferred()
		const release = deferred()
		const original = f.agenda.read.bind(f.agenda)
		vi.spyOn(f.agenda, 'read').mockImplementationOnce(async () => {
			const state = await original()
			entered.resolve()
			await release.promise
			return state
		})
		const first = resumeFirst ? host.resume() : host.pause()
		await entered.promise
		expect(() => host.run({ signal, maxSteps: 1 })).toThrow('pending resident controls')
		await expect(host.resume()).rejects.toThrow('pending resident controls')
		const lastPause = host.pause()
		release.resolve()
		await Promise.all([first, lastPause])
		expect((await snapshot(f.reopen())).paused).toBe(true)
		expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({
			status: 'paused',
			stepsSettled: 0,
		})
	}
})
