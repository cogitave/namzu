import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { type ResidentStep, runResident, stepResident } from './loop.js'
import { DiskResidentStore, ResidentConflictError } from './store.js'

const roots: string[] = []
const signal = new AbortController().signal
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'researcher' }
	const store = new DiskResidentStore(root, scope)
	await store.create('A careful researcher', 'Investigate one question, then rest.')
	return {
		root,
		scope,
		store,
		reopen: () => new DiskResidentStore(root, scope),
	}
}

it('retains identity and prior outcome across restart; idle and complete states spend no steps', async () => {
	const f = await fixture()
	await stepResident(
		f.store,
		async () => ({
			kind: 'wait',
			wakeAt: 20,
			summary: 'Found the first clue.',
		}),
		signal,
		() => 10,
	)
	const step = vi.fn<ResidentStep>(async () => ({
		kind: 'complete' as const,
		summary: 'Verified the answer.',
	}))
	expect(await stepResident(f.reopen(), step, signal, () => 19)).toMatchObject({
		status: 'idle',
		reason: 'not-due',
	})
	expect(step).not.toHaveBeenCalled()
	await stepResident(f.reopen(), step, signal, () => 20)
	expect(step.mock.calls[0]?.[0]).toMatchObject({
		identity: 'A careful researcher',
		summary: 'Found the first clue.',
		stepsAdmitted: 2,
	})
	await stepResident(f.reopen(), step, signal, () => 21)
	expect(step).toHaveBeenCalledTimes(1)
})

it('admits only one competing owner before either callback executes', async () => {
	const f = await fixture()
	let release!: () => void
	const barrier = new Promise<void>((resolve) => {
		release = resolve
	})
	const step = vi.fn<ResidentStep>(async () => {
		await barrier
		return { kind: 'complete' as const, summary: 'One owner.' }
	})
	const attempts = [stepResident(f.store, step, signal), stepResident(f.reopen(), step, signal)]
	await vi.waitFor(() => expect(step).toHaveBeenCalledTimes(1))
	release()
	const results = await Promise.all(attempts)
	expect(results.filter((result) => result.status === 'settled')).toHaveLength(1)
	expect(step).toHaveBeenCalledTimes(1)
})

it('never automatically repeats a crashed step; explicit reconciliation fences a late result', async () => {
	const f = await fixture()
	await expect(
		stepResident(
			f.store,
			async () => {
				throw new Error('connection lost after effect')
			},
			signal,
		),
	).rejects.toThrow('connection lost')
	const oldClaim = await requiredState(f.store)
	const repeated = vi.fn()
	expect(await stepResident(f.reopen(), repeated, signal)).toMatchObject({
		status: 'idle',
		reason: 'unresolved',
	})
	expect(repeated).not.toHaveBeenCalled()
	await f.reopen().settle(
		oldClaim,
		{
			kind: 'complete',
			summary: 'Host confirmed effect and stopped old worker.',
		},
		Date.now(),
	)
	await expect(
		f.store.settle(oldClaim, { kind: 'blocked', summary: 'Late owner.' }, Date.now()),
	).rejects.toBeInstanceOf(ResidentConflictError)
})

it('waits for new evidence without timers or calls, then admits the explicit wake', async () => {
	const f = await fixture()
	await stepResident(
		f.store,
		async () => ({ kind: 'wait', wakeAt: null, summary: 'Need new evidence.' }),
		signal,
	)
	const step = vi.fn<ResidentStep>(async () => ({
		kind: 'complete' as const,
		summary: 'Evidence received.',
	}))
	expect(await runResident({ store: f.store, step, signal, maxSteps: 2 })).toMatchObject({
		status: 'idle',
		reason: 'not-due',
	})
	expect(step).not.toHaveBeenCalled()
	await f.store.wake(await requiredState(f.store), 'New experiment result arrived.', Date.now())
	await runResident({ store: f.store, step, signal, maxSteps: 2 })
	expect(step).toHaveBeenCalledTimes(1)
	await expect(f.store.wake(await requiredState(f.store), 'Repeat', Date.now())).rejects.toThrow(
		'waiting',
	)
})

it('continues without another user message but stops at its explicit admission cap', async () => {
	const f = await fixture()
	const step = vi.fn<ResidentStep>(async () => ({
		kind: 'wait' as const,
		wakeAt: Date.now() + 1_000,
		summary: 'Next internal step.',
	}))
	await runResident({ store: f.store, step, signal, maxSteps: 2 })
	expect(step).toHaveBeenCalledTimes(2)
	expect((await f.store.read())?.stepsAdmitted).toBe(2)
})

it('aborts idle waits and leaves an aborted active step unresolved', async () => {
	const f = await fixture()
	await stepResident(
		f.store,
		async () => ({
			kind: 'wait',
			wakeAt: Date.now() + 60_000,
			summary: 'Rest.',
		}),
		signal,
	)
	const controller = new AbortController()
	const step = vi.fn()
	const pending = runResident({
		store: f.store,
		step,
		signal: controller.signal,
		maxSteps: 2,
	})
	controller.abort()
	await expect(pending).rejects.toThrow()
	expect(step).not.toHaveBeenCalled()
	await f.store.wake(await requiredState(f.store), 'New evidence.', Date.now())
	const active = new AbortController()
	await expect(
		stepResident(
			f.store,
			async () => {
				active.abort()
				return { kind: 'complete', summary: 'Unconfirmed.' }
			},
			active.signal,
		),
	).rejects.toThrow()
	expect((await f.store.read())?.phase).toBe('running')
})

it('validates scope, persisted data, future scheduling and finite loop bounds', async () => {
	const f = await fixture()
	expect(
		await new DiskResidentStore(f.root, {
			...f.scope,
			tenantId: generateTenantId(),
		}).read(),
	).toBeNull()
	await expect(f.store.create('Duplicate', 'Duplicate')).rejects.toBeInstanceOf(
		ResidentConflictError,
	)
	await expect(
		runResident({
			store: f.store,
			step: vi.fn(),
			signal,
			maxSteps: Number.POSITIVE_INFINITY,
		}),
	).rejects.toThrow('maxSteps')
	await expect(
		stepResident(
			f.store,
			async () => ({ kind: 'wait', wakeAt: 1, summary: 'Busy loop.' }),
			signal,
			() => 1,
		),
	).rejects.toThrow('future')
	const state = await requiredState(f.store)
	await writeFile(
		join(f.root, f.scope.tenantId, f.scope.agentKey, 'revisions', `${state.revision}.json`),
		JSON.stringify({
			...state,
			tenantId: generateTenantId(),
			schemaVersion: 1,
		}),
	)
	await expect(f.store.read()).rejects.toThrow('bound tenant')
})

async function requiredState(store: DiskResidentStore) {
	const state = await store.read()
	if (!state) throw new Error('Fixture state is missing')
	return state
}

it('returns long idle waits to the host and never invokes a blocked pursuit', async () => {
	const f = await fixture()
	await stepResident(
		f.store,
		async () => ({ kind: 'wait', wakeAt: Date.now() + 60_000, summary: 'Deferred work.' }),
		signal,
	)
	const step = vi.fn<ResidentStep>(async () => ({ kind: 'blocked', summary: 'Needs host input.' }))
	expect(
		await runResident({ store: f.store, step, signal, maxSteps: 2, maxIdleMs: 0 }),
	).toMatchObject({ status: 'idle', reason: 'not-due' })
	expect(step).not.toHaveBeenCalled()
	await f.store.wake(await requiredState(f.store), 'Check prerequisite.', Date.now())
	await runResident({ store: f.store, step, signal, maxSteps: 2 })
	expect(await stepResident(f.store, step, signal)).toMatchObject({
		status: 'idle',
		reason: 'terminal',
		state: { phase: 'blocked' },
	})
	expect(step).toHaveBeenCalledTimes(1)
})

it('cancels after idle sleep is actually entered', async () => {
	const f = await fixture()
	await stepResident(
		f.store,
		async () => ({ kind: 'wait', wakeAt: Date.now() + 60_000, summary: 'Resting.' }),
		signal,
	)
	const controller = new AbortController()
	const original = f.store.read.bind(f.store)
	let observed!: () => void
	const readCompleted = new Promise<void>((resolve) => {
		observed = resolve
	})
	vi.spyOn(f.store, 'read').mockImplementation(async () => {
		const state = await original()
		observed()
		return state
	})
	const step = vi.fn()
	const pending = runResident({ store: f.store, step, signal: controller.signal, maxSteps: 2 })
	const rejection = expect(pending).rejects.toThrow()
	await readCompleted
	await new Promise<void>((resolve) => setImmediate(resolve))
	controller.abort()
	await rejection
	expect(step).not.toHaveBeenCalled()
	expect((await original())?.phase).toBe('waiting')
})
