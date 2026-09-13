import assert from 'node:assert/strict'
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots)
	roots.length = 0
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'resident-activity-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'audit' }
	const agenda = new DiskResidentAgenda(root, scope)
	const pursuit = await agenda.add(
		await agenda.create('Inspect only authorized work.'),
		'Inspect package metadata.',
	)
	const snapshot = async () => {
		const value = await agenda.read()
		assert.ok(value)
		return value
	}
	const state = async () => {
		const value = (await snapshot()).pursuits.find((p) => p.id === pursuit.id)?.state
		assert.ok(value)
		return value
	}
	const step = async (outcome: 'wait' | 'complete' = 'wait') => {
		const current = await state()
		const execution = agenda.execution(pursuit.id)
		const claim = await execution.claim(current, Date.now())
		await execution.settle(
			claim,
			outcome === 'wait'
				? { kind: 'wait', summary: 'Waiting.', wakeAt: null }
				: { kind: 'complete', summary: 'Done.' },
			Date.now(),
		)
		return claim
	}
	return {
		root,
		scope,
		agenda,
		pursuit,
		snapshot,
		state,
		step,
		revisions: join(root, scope.tenantId, scope.agentKey, 'agenda', 'revisions'),
	}
}

it('retains admissions across restart, settlement, archive and page boundaries', async () => {
	const f = await fixture()
	const first = await f.step()
	await f.agenda.wake(f.pursuit.id, await f.state(), 'New evidence.', Date.now())
	const second = await f.step('complete')
	await f.agenda.archive(await f.snapshot(), { pursuitIds: [f.pursuit.id] })
	const boundary = (await f.snapshot()).revision
	const source = new DiskResidentAgenda(f.root, f.scope).activity(boundary)
	const admissions = []
	const settlements = []
	const archives = []
	let cursor: number | undefined
	for (let i = 0; i < boundary; i++) {
		const page = await source.read({ cursor, maxRevisions: 1 })
		admissions.push(...page.admissions)
		settlements.push(...page.settlements)
		archives.push(...page.archivedPursuits)
		expect(page.unavailableRevisions).toEqual([])
		if (page.nextCursor === null) break
		cursor = page.nextCursor
	}
	expect(admissions.map((a) => a.claimId)).toEqual([first.claimId, second.claimId])
	expect(settlements.map((s) => s.outcome)).toEqual(['wait', 'complete'])
	expect(archives).toEqual([f.pursuit.id])
	expect((await f.snapshot()).pursuits).toEqual([])
})

it('does not turn an admitted callback into a settlement or advance its boundary', async () => {
	const f = await fixture()
	await f.agenda.execution(f.pursuit.id).claim(await f.state(), Date.now())
	const source = f.agenda.activity((await f.snapshot()).revision)
	await f.agenda.setPaused(await f.snapshot(), true)
	const page = await source.read()
	expect(page.admissions).toHaveLength(1)
	expect(page.settlements).toHaveLength(0)
	expect(page.throughRevision).toBe(source.scope.throughRevision)
})

it('a missing predecessor makes the transition unavailable, not evidence of no work', async () => {
	const f = await fixture()
	await f.step()
	await unlink(join(f.revisions, '2.json'))
	const page = await f.agenda.activity((await f.snapshot()).revision).read()
	expect(page.unavailableRevisions).toEqual([2])
	expect(page.admissions).toEqual([])
	expect(page.settlements).toHaveLength(1)
})

it('rejects a foreign scope or misnamed immutable revision', async () => {
	const f = await fixture()
	await f.step()
	const path = join(f.revisions, '3.json')
	const raw = JSON.parse(await readFile(path, 'utf8'))
	// The revision store envelope keeps scope under its payload.
	const visit = (value: Record<string, unknown>) => {
		if ('tenantId' in value) value.tenantId = generateTenantId()
		for (const item of Object.values(value))
			if (item && typeof item === 'object' && !Array.isArray(item))
				visit(item as Record<string, unknown>)
	}
	visit(raw)
	await writeFile(path, JSON.stringify(raw))
	const page = await f.agenda.activity((await f.snapshot()).revision).read()
	expect(page.unavailableRevisions).toContain(3)
	expect(page.admissions).toEqual([])
})

it('stops before reading a record larger than the remaining byte allowance', async () => {
	const f = await fixture()
	await f.step()
	const page = await f.agenda.activity((await f.snapshot()).revision).read({ maxReadBytes: 1 })
	expect(page).toMatchObject({
		fromRevision: 1,
		throughRevision: 0,
		nextCursor: 1,
		scannedBytes: 0,
	})
	expect(page.unavailableRevisions).toEqual([])
})

it('honors cancellation before reading disk and rejects invalid page bounds', async () => {
	const f = await fixture()
	const source = f.agenda.activity((await f.snapshot()).revision)
	const controller = new AbortController()
	controller.abort(new Error('stop'))
	await expect(source.read({}, controller.signal)).rejects.toThrow('stop')
	for (const options of [{ cursor: 0 }, { cursor: 1e6 }, { maxRevisions: 33 }, { maxReadBytes: 0 }])
		await expect(source.read(options)).rejects.toThrow()
})
