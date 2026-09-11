import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SchemaVersionError, defineSchema, migrate } from '../../store/schema.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { stepResident } from './loop.js'
import { ResidentConflictError } from './store.js'

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function snapshot(agenda: DiskResidentAgenda) {
	const state = await agenda.read()
	if (!state) throw new Error('Missing agenda fixture')
	return state
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-agenda-pause-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'pause-test' }
	const agenda = new DiskResidentAgenda(root, scope)
	const initial = await agenda.create('Careful resident')
	const revisions = join(root, scope.tenantId, scope.agentKey, 'agenda', 'revisions')
	return {
		agenda,
		initial,
		revisions,
		reopen: () => new DiskResidentAgenda(root, scope),
		path: (revision: number) => join(revisions, `${revision}.json`),
	}
}

it('retains every committed pause request through rapid resumes and reopening', async () => {
	const f = await fixture()
	expect(f.initial).not.toHaveProperty('pauseGeneration')
	const unchanged = await f.agenda.setPaused(f.initial, false)
	expect(unchanged).not.toHaveProperty('pauseGeneration')
	const first = await f.agenda.setPaused(unchanged, true)
	expect(first).toMatchObject({ paused: true, pauseGeneration: 1 })
	const resumed = await f.agenda.setPaused(first, false)
	expect(await f.reopen().read()).toEqual(resumed)
	expect(resumed).toMatchObject({ paused: false, pauseGeneration: 1 })
	const second = await f.agenda.setPaused(resumed, true)
	const repeated = await f.agenda.setPaused(second, true)
	expect(repeated).toMatchObject({ paused: true, pauseGeneration: 3 })
	expect(await f.reopen().readRevision(first.revision)).toEqual(first)
	expect(await f.reopen().read()).toEqual(repeated)
})

it('counts only committed pause requests when independent agenda owners contend', async () => {
	const f = await fixture()
	const outcomes = await Promise.allSettled([
		f.agenda.setPaused(f.initial, true),
		f.reopen().setPaused(f.initial, true),
	])
	expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
	for (const outcome of outcomes)
		if (outcome.status === 'rejected') expect(outcome.reason).toBeInstanceOf(ResidentConflictError)
	const current = await snapshot(f.reopen())
	expect(current).toMatchObject({ paused: true, pauseGeneration: 1 })
	await expect(f.agenda.setPaused(f.initial, false)).rejects.toBeInstanceOf(ResidentConflictError)
	expect(await f.reopen().setPaused(current, true)).toMatchObject({
		paused: true,
		pauseGeneration: 2,
	})
})

it('fences admission authorized before a pause even when another owner already resumed', async () => {
	const f = await fixture()
	const pursuit = await f.agenda.add(f.initial, 'One authorized step')
	const authorized = await snapshot(f.agenda)
	const staleExecution = f.agenda.executionAt(pursuit.id, authorized)
	const remote = f.reopen()
	const paused = await remote.setPaused(authorized, true)
	const resumed = await remote.setPaused(paused, false)
	expect(resumed.paused).toBe(false)
	expect(resumed.pauseGeneration).not.toBe(authorized.pauseGeneration ?? 0)
	const step = vi.fn(async () => ({ kind: 'complete' as const, summary: 'Verified' }))
	const signal = new AbortController().signal
	expect(await stepResident(staleExecution, step, signal)).toMatchObject({
		status: 'idle',
		reason: 'contended',
	})
	expect(step).not.toHaveBeenCalled()
	expect(await snapshot(f.agenda)).toEqual(resumed)
	expect(await stepResident(f.agenda.executionAt(pursuit.id, resumed), step, signal)).toMatchObject(
		{ status: 'settled' },
	)
	expect(step).toHaveBeenCalledTimes(1)
	expect((await snapshot(f.reopen())).pauseGeneration).toBe(1)
})

it.each([1, 2, 3, 4])(
	'reads schema %i without inventing a generation and fences older writers after a pause',
	async (schemaVersion) => {
		const f = await fixture()
		const raw = JSON.stringify({ ...f.initial, schemaVersion })
		await writeFile(f.path(f.initial.revision), raw)
		const reopened = f.reopen()
		const historical = await snapshot(reopened)
		expect(historical).toEqual(f.initial)
		expect(historical).not.toHaveProperty('pauseGeneration')
		expect(await readFile(f.path(f.initial.revision), 'utf8')).toBe(raw)
		const paused = await reopened.setPaused(historical, true)
		const written = JSON.parse(await readFile(f.path(paused.revision), 'utf8'))
		expect(written).toMatchObject({ schemaVersion: 5, pauseGeneration: 1 })
		expect(() =>
			migrate(
				defineSchema({
					kind: 'resident-agenda',
					current: 4,
					migrations: { 1: (v) => v, 2: (v) => v, 3: (v) => v },
				}),
				written,
			),
		).toThrow(SchemaVersionError)
	},
)

it('refuses pause generation overflow without publishing or changing admission', async () => {
	const f = await fixture()
	const raw = JSON.stringify({
		...f.initial,
		pauseGeneration: Number.MAX_SAFE_INTEGER,
		schemaVersion: 5,
	})
	await writeFile(f.path(f.initial.revision), raw)
	const current = await snapshot(f.reopen())
	await expect(f.agenda.setPaused(current, true)).rejects.toThrow()
	expect(await readFile(f.path(f.initial.revision), 'utf8')).toBe(raw)
	expect(await readdir(f.revisions)).toEqual(['1.json'])
	expect(await snapshot(f.agenda)).toEqual(current)
	expect(await f.agenda.setPaused(current, false)).toMatchObject({
		paused: false,
		pauseGeneration: Number.MAX_SAFE_INTEGER,
	})
})
