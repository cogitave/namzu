import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { type ResidentStep, stepResident } from './loop.js'
import { DiskResidentStore } from './store.js'

const roots: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(agentKey = 'admission-check') {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-admission-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey }
	const store = new DiskResidentStore(root, scope)
	const initial = await store.create('A careful researcher', 'Check one fact, then rest.')
	return { root, scope, store, initial, reopen: () => new DiskResidentStore(root, scope) }
}

it('does not admit work when cancellation arrives during the asynchronous state read', async () => {
	const f = await fixture()
	const controller = new AbortController()
	const read = f.store.read.bind(f.store)
	vi.spyOn(f.store, 'read').mockImplementationOnce(async () => {
		const state = await read()
		controller.abort(new Error('Operator took over during the read.'))
		return state
	})
	const claim = vi.spyOn(f.store, 'claim')
	const step = vi.fn<ResidentStep>(async () => ({ kind: 'complete', summary: 'Unexpected work.' }))

	await expect(stepResident(f.store, step, controller.signal)).rejects.toThrow(
		'Operator took over during the read.',
	)

	expect(claim).not.toHaveBeenCalled()
	expect(step).not.toHaveBeenCalled()
	expect(await f.reopen().read()).toEqual(f.initial)
})

it('preserves an admitted claim when cancellation arrives before the callback can start', async () => {
	const f = await fixture()
	const controller = new AbortController()
	const claim = f.store.claim.bind(f.store)
	vi.spyOn(f.store, 'claim').mockImplementationOnce(async (...args) => {
		const admitted = await claim(...args)
		controller.abort(new Error('Operator took over during admission.'))
		return admitted
	})
	const step = vi.fn<ResidentStep>(async () => ({ kind: 'complete', summary: 'Unexpected work.' }))

	await expect(stepResident(f.store, step, controller.signal)).rejects.toThrow(
		'Operator took over during admission.',
	)
	expect(step).not.toHaveBeenCalled()

	const reopened = f.reopen()
	const unresolved = await reopened.read()
	expect(unresolved).toMatchObject({ phase: 'running', stepsAdmitted: 1 })
	expect(unresolved?.claimId).toEqual(expect.any(String))
	expect(await stepResident(reopened, step, new AbortController().signal)).toMatchObject({
		status: 'idle',
		reason: 'unresolved',
	})
	expect(step).not.toHaveBeenCalled()

	if (!unresolved) throw new Error('The admitted claim was lost.')
	await reopened.settle(
		unresolved,
		{ kind: 'wait', wakeAt: null, summary: 'Host confirmed the callback never started.' },
		Date.now(),
	)
	expect(await f.reopen().read()).toMatchObject({
		phase: 'waiting',
		claimId: null,
		wakeAt: null,
		stepsAdmitted: 1,
	})
})

it('creates and reopens a valid Unicode agent key without filesystem component overflow', async () => {
	const agentKey = 'ğ'.repeat(60)
	const f = await fixture(agentKey)

	expect(await f.reopen().read()).toEqual(f.initial)
	expect(f.initial.agentKey).toBe(agentKey)
	const other = new DiskResidentStore(f.root, {
		...f.scope,
		agentKey: `${'ğ'.repeat(59)}ş`,
	})
	expect(await other.read()).toBeNull()
	await other.create('Another researcher', 'Keep a distinct pursuit.')
	expect((await other.read())?.identity).toBe('Another researcher')
	expect(await f.reopen().read()).toEqual(f.initial)
})

it('preserves existing encoded paths at the filesystem filename limit', async () => {
	const f = await fixture('ğ'.repeat(51))
	const path = join(f.root, f.scope.tenantId, '~011f'.repeat(51), 'revisions', '1.json')
	expect(JSON.parse(await readFile(path, 'utf8')).agentKey).toBe(f.scope.agentKey)
	expect(await f.reopen().read()).toEqual(f.initial)
})

it('does not use an agenda snapshot to admit work in the standalone store', async () => {
	const f = await fixture()
	const agenda = new DiskResidentAgenda(f.root, f.scope)
	const pursuit = await agenda.add(await agenda.create(f.initial.identity), f.initial.objective)
	await expect(f.store.claim(pursuit.state, Date.now())).rejects.toThrow('bound tenant and agent')
	expect(await f.reopen().read()).toEqual(f.initial)
})
