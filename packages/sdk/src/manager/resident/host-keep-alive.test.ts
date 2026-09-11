import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { ResidentHost, type ResidentPursuitStep } from './host.js'

const roots: string[] = []
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

async function snapshot(agenda: DiskResidentAgenda) {
	const state = await agenda.read()
	if (!state) throw new Error('Missing keep-alive fixture agenda')
	return state
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-keep-alive-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'keep-alive' }
	const agenda = new DiskResidentAgenda(root, scope)
	await agenda.create('Careful resident')
	return { agenda, reopen: () => new DiskResidentAgenda(root, scope) }
}

it('waits without callbacks for additions and indefinite wakes within one original step cap', async () => {
	const f = await fixture()
	const empty = deferred()
	const resting = deferred()
	const read = f.agenda.read.bind(f.agenda)
	vi.spyOn(f.agenda, 'read').mockImplementation(async () => {
		const state = await read()
		if (state?.pursuits.length === 0) empty.resolve()
		if (state?.pursuits[0]?.state.summary === 'Saved first observation') resting.resolve()
		return state
	})
	const step = vi.fn<ResidentPursuitStep>(async ({ state }) =>
		state.stepsAdmitted === 1
			? { kind: 'wait', wakeAt: null, summary: 'Saved first observation' }
			: { kind: 'complete', summary: `Verified from ${state.summary}` },
	)
	const host = new ResidentHost(f.agenda, step)
	const controller = new AbortController()
	let returned = false
	const pending = host
		.run({ signal: controller.signal, maxSteps: 2, maxIdleMs: 60_000, keepAlive: true })
		.finally(() => {
			returned = true
		})
	try {
		await empty.promise
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(returned).toBe(false)
		expect(step).not.toHaveBeenCalled()
		const added = await f.reopen().add(await snapshot(f.reopen()), 'Inspect the new evidence')
		host.notify()
		await resting.promise
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(step).toHaveBeenCalledTimes(1)
		expect(returned).toBe(false)
		await host.wake(added.id, 'Additional evidence arrived')
		expect(await pending).toMatchObject({ status: 'limit', stepsSettled: 2 })
		expect(step).toHaveBeenCalledTimes(2)
		expect((await snapshot(f.reopen())).pursuits[0]?.state).toMatchObject({
			phase: 'complete',
			stepsAdmitted: 2,
			summary: 'Verified from Saved first observation',
		})
		await f.reopen().add(await snapshot(f.reopen()), 'Outside the exhausted invocation')
		host.notify()
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(step).toHaveBeenCalledTimes(2)
	} finally {
		controller.abort()
		await pending
	}
})

it('checks distant scheduled work on bounded timers without invoking it before due time', async () => {
	const f = await fixture()
	const pursuit = await f.agenda.add(await snapshot(f.agenda), 'Tomorrow’s evidence')
	const start = Date.now()
	const wakeAt = start + 86_400_000
	await f.agenda.wake(pursuit.id, pursuit.state, 'Scheduled evidence', wakeAt)
	let now = start
	vi.spyOn(Date, 'now').mockImplementation(() => now)
	const polled = deferred()
	const read = f.agenda.read.bind(f.agenda)
	let reads = 0
	vi.spyOn(f.agenda, 'read').mockImplementation(async () => {
		const state = await read()
		if (++reads === 3) polled.resolve()
		return state
	})
	const step = vi.fn<ResidentPursuitStep>(async () => {
		expect(Date.now()).toBeGreaterThanOrEqual(wakeAt)
		return { kind: 'complete', summary: 'Checked the scheduled evidence' }
	})
	const controller = new AbortController()
	const pending = new ResidentHost(f.agenda, step).run({
		signal: controller.signal,
		maxSteps: 1,
		maxIdleMs: 5,
		keepAlive: true,
	})
	try {
		await polled.promise
		expect(step).not.toHaveBeenCalled()
		now = wakeAt
		expect(await pending).toMatchObject({ status: 'limit', stepsSettled: 1 })
		expect(step).toHaveBeenCalledTimes(1)
	} finally {
		controller.abort()
		await pending
	}
})

it('rests after the last terminal pursuit and observes a later addition without notify', async () => {
	const f = await fixture()
	const first = await f.agenda.add(await snapshot(f.agenda), 'First task')
	const terminal = deferred()
	const read = f.agenda.read.bind(f.agenda)
	let terminalReads = 0
	vi.spyOn(f.agenda, 'read').mockImplementation(async () => {
		const state = await read()
		if (state?.pursuits.length === 1 && state.pursuits[0]?.state.phase === 'complete')
			if (++terminalReads === 3) terminal.resolve()
		return state
	})
	const step = vi.fn<ResidentPursuitStep>(async ({ state }) => ({
		kind: 'complete',
		summary: state.objective,
	}))
	const controller = new AbortController()
	const pending = new ResidentHost(f.agenda, step).run({
		signal: controller.signal,
		maxSteps: 2,
		maxIdleMs: 5,
		keepAlive: true,
	})
	try {
		await terminal.promise
		expect(step).toHaveBeenCalledTimes(1)
		const second = await f.reopen().add(await snapshot(f.reopen()), 'Later task')
		expect(await pending).toMatchObject({ status: 'limit', stepsSettled: 2 })
		expect(step.mock.calls.map(([pursuit]) => pursuit.id)).toEqual([first.id, second.id])
	} finally {
		controller.abort()
		await pending
	}
})

it('aborts an empty idle wait immediately without spending the step cap', async () => {
	const f = await fixture()
	const read = f.agenda.read.bind(f.agenda)
	const entered = deferred()
	vi.spyOn(f.agenda, 'read').mockImplementation(async () => {
		const state = await read()
		entered.resolve()
		return state
	})
	const step = vi.fn()
	const controller = new AbortController()
	const pending = new ResidentHost(f.agenda, step).run({
		signal: controller.signal,
		maxSteps: 3,
		maxIdleMs: 60_000,
		keepAlive: true,
	})
	await entered.promise
	await new Promise<void>((resolve) => setImmediate(resolve))
	controller.abort()
	expect(await pending).toMatchObject({ status: 'cancelled', stepsSettled: 0 })
	expect(step).not.toHaveBeenCalled()
})

it.each(['paused', 'unresolved'] as const)(
	'returns %s instead of waiting or admitting work',
	async (phase) => {
		const f = await fixture()
		const pursuit = await f.agenda.add(await snapshot(f.agenda), 'Pending task')
		if (phase === 'paused') await f.agenda.setPaused(await snapshot(f.agenda), true)
		else await f.agenda.execution(pursuit.id).claim(pursuit.state, Date.now())
		const step = vi.fn()
		expect(
			await new ResidentHost(f.agenda, step).run({
				signal: new AbortController().signal,
				maxSteps: 1,
				keepAlive: true,
			}),
		).toMatchObject({ status: phase, stepsSettled: 0 })
		expect(step).not.toHaveBeenCalled()
	},
)
