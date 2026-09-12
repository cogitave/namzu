import { mkdtemp, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import type { ResidentHistorySource } from './history.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots)
	roots.length = 0
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-history-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'reviewer' }
	const agenda = new DiskResidentAgenda(root, scope)
	const pursuit = await agenda.add(
		await agenda.create('Handle delivery evidence.'),
		'Check the DELTA delivery.',
	)
	const revisions = join(root, scope.tenantId, scope.agentKey, 'agenda', 'revisions')
	const snapshot = async () => {
		const state = await agenda.read()
		if (!state) throw new Error('Missing fixture agenda.')
		return state
	}
	const state = async () => {
		const current = (await snapshot()).pursuits.find((p) => p.id === pursuit.id)?.state
		if (!current) throw new Error('Missing fixture pursuit.')
		return current
	}
	const step = async (summary: string, evidence: string[] = []) => {
		for (const reason of evidence) await agenda.wake(pursuit.id, await state(), reason, Date.now())
		const execution = agenda.execution(pursuit.id)
		const claim = await execution.claim(await state(), Date.now())
		await execution.settle(claim, { kind: 'wait', summary, wakeAt: null }, Date.now())
		return (await snapshot()).revision
	}
	const history = async () =>
		new DiskResidentAgenda(root, scope).history(await state(), (await snapshot()).revision)
	return { root, scope, agenda, pursuit, revisions, snapshot, state, step, history }
}

async function all(source: ResidentHistorySource, query: string) {
	let cursor: number | undefined
	const matches = []
	for (let i = 0; i < 100; i++) {
		const page = await source.search({ query, cursor })
		expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
		expect(page.scannedRevisions).toBeLessThanOrEqual(32)
		matches.push(...page.matches)
		if (page.nextCursor === null) return matches
		if (cursor !== undefined) expect(page.nextCursor).toBeLessThan(cursor)
		cursor = page.nextCursor
	}
	throw new Error('History pagination did not make progress.')
}

it('recovers an exact earlier decision and consumed wake evidence after the last summary forgets them', async () => {
	const f = await fixture()
	const first = await f.step('DELTA delivery code TOKEN-ALPHA; destination old depot.', [
		'DELTA original request receipt WAKE-ALPHA.',
	])
	const correction = await f.step('Awaiting recipient confirmation.', [
		'DELTA correction: destination new depot; delivery code unchanged.',
	])
	const before = await readdir(f.revisions)
	const source = await f.history()
	expect((await f.state()).summary).not.toContain('TOKEN-ALPHA')
	expect((await f.state()).wakeEvidence).toBeUndefined()
	const page = await source.search({ query: 'DELTA' })
	expect(page.incomplete).toBe(false)
	expect(page.matches.map((match) => match.revision)).toEqual([correction, first])
	expect(page.matches[0]).toMatchObject({ source: 'wake', matchingParts: [1] })
	const text = await source.read({ revision: first, part: 0 })
	expect(text.entry).toMatchObject({
		step: 1,
		kind: 'wait',
		source: 'summary',
		text: 'DELTA delivery code TOKEN-ALPHA; destination old depot.',
		nextOffset: null,
	})
	const wake = await source.read({ revision: first, part: 1 })
	expect(wake.entry).toMatchObject({
		source: 'wake',
		text: 'DELTA original request receipt WAKE-ALPHA.',
		receivedAt: expect.any(Number),
	})
	expect(await readdir(f.revisions)).toEqual(before)
})

it('keeps each occurrence at its own address, while controls and unresolved claims are not completed steps', async () => {
	const f = await fixture()
	const first = await f.step('Repeated receipt.')
	const second = await f.step('Repeated receipt.', ['Continue.'])
	await f.agenda.setPaused(await f.snapshot(), true)
	await f.agenda.setPaused(await f.snapshot(), false)
	await f.agenda.wake(f.pursuit.id, await f.state(), 'New input.', Date.now())
	await f.agenda.execution(f.pursuit.id).claim(await f.state(), Date.now())
	const page = await (await f.history()).search()
	expect(page.matches.map((m) => m.revision)).toEqual([second, first])
	expect(page.matches.map((m) => m.step)).toEqual([2, 1])
	expect(new Set(page.matches.map((m) => m.claimId)).size).toBe(2)
	expect(
		(await (await f.history()).read({ revision: (await f.snapshot()).revision, part: 0 })).entry,
	).toBeNull()
})

it('freezes the upper revision and excludes another pursuit and foreign tenant', async () => {
	const f = await fixture()
	const own = await f.step('Common receipt OWN-ALPHA.')
	const bound = await f.history()
	const other = await f.agenda.add(await f.snapshot(), 'A separate private task.')
	const execution = f.agenda.execution(other.id)
	const claim = await execution.claim(other.state, Date.now())
	await execution.settle(
		claim,
		{ kind: 'complete', summary: 'Common receipt FOREIGN-BETA.' },
		Date.now(),
	)
	const future = await f.step('Common receipt LATER-GAMMA.', ['Continue.'])
	expect((await bound.search({ query: 'Common' })).matches.map((m) => m.revision)).toEqual([own])
	await expect(bound.read({ revision: future, part: 0 })).rejects.toThrow()
	await expect(bound.search({ cursor: future })).rejects.toThrow()
	const current = await f.history()
	expect((await current.search({ query: 'Common' })).matches.map((m) => m.revision)).toEqual([
		future,
		own,
	])
	expect(JSON.stringify(await current.search())).not.toContain('FOREIGN-BETA')
	expect(() =>
		new DiskResidentAgenda(f.root, { ...f.scope, tenantId: generateTenantId() }).history(
			claim,
			own,
		),
	).toThrow('belonging')
})

it('reads a terminal pursuit after archival without confusing archive controls with new results', async () => {
	const f = await fixture()
	const first = await f.step('Earlier exact receipt ARCHIVE-ALPHA.')
	await f.agenda.wake(f.pursuit.id, await f.state(), 'Finish now.', Date.now())
	const execution = f.agenda.execution(f.pursuit.id)
	const terminal = await execution.settle(
		await execution.claim(await f.state(), Date.now()),
		{ kind: 'complete', summary: 'Delivery complete.' },
		Date.now(),
	)
	const finishedAt = (await f.snapshot()).revision
	await f.agenda.archive(await f.snapshot(), { pursuitIds: [f.pursuit.id] })
	const reopened = new DiskResidentAgenda(f.root, f.scope)
	const source = reopened.history(terminal, (await f.snapshot()).revision)
	expect((await source.search()).matches.map((m) => m.revision)).toEqual([finishedAt, first])
	expect((await source.read({ revision: first, part: 0 })).entry?.text).toContain('ARCHIVE-ALPHA')
})

it('continues through empty bounded pages and allows a returned cursor after reopening', async () => {
	const f = await fixture()
	const first = await f.step('OLD-RECEIPT.')
	for (let i = 0; i < 75; i++) await f.agenda.setPaused(await f.snapshot(), i % 2 === 0)
	const source = await f.history()
	const page = await source.search({ query: 'OLD-RECEIPT' })
	expect(page.matches).toEqual([])
	expect(page.incomplete).toBe(true)
	expect(page.scannedRevisions).toBe(32)
	expect(page.nextCursor).not.toBeNull()
	const reopened = await f.history()
	expect(
		await reopened.search({ query: 'OLD-RECEIPT', cursor: page.nextCursor ?? undefined }),
	).toEqual(await source.search({ query: 'OLD-RECEIPT', cursor: page.nextCursor ?? undefined }))
	expect((await all(reopened, 'OLD-RECEIPT')).map((m) => m.revision)).toEqual([first])
})

it('limits bytes before parsing and still makes progress across large historical records', async () => {
	const f = await fixture()
	const first = await f.step('RECORDED first.')
	const second = await f.step('RECORDED second.', ['Continue.'])
	for (const name of await readdir(f.revisions)) {
		const path = join(f.revisions, name)
		const record = JSON.parse(await readFile(path, 'utf8'))
		await writeFile(path, JSON.stringify({ ...record, fixturePadding: 'x'.repeat(3_000_000) }))
	}
	const source = await f.history()
	const page = await source.search({ query: 'RECORDED' })
	expect(page.scannedBytes).toBeGreaterThan(6_000_000)
	expect(page.scannedBytes).toBeLessThanOrEqual(8 * 1024 * 1024)
	expect(page.nextCursor).not.toBeNull()
	expect((await all(source, 'RECORDED')).map((m) => m.revision)).toEqual([second, first])
})

it.each(['missing', 'corrupt', 'oversized', 'symlink', 'wrong-identity'] as const)(
	'reports %s history as unavailable instead of treating absence as proof',
	async (failure) => {
		const f = await fixture()
		const revision = await f.step('RECORDED evidence.')
		const source = await f.history()
		const path = join(f.revisions, `${revision - 1}.json`)
		if (failure === 'missing') await unlink(path)
		if (failure === 'corrupt') await writeFile(path, '{broken')
		if (failure === 'oversized') await writeFile(path, 'x'.repeat(4 * 1024 * 1024 + 1))
		if (failure === 'symlink') {
			await unlink(path)
			await symlink(join(f.revisions, `${revision}.json`), path)
		}
		if (failure === 'wrong-identity') {
			const record = JSON.parse(await readFile(path, 'utf8'))
			await writeFile(path, JSON.stringify({ ...record, tenantId: generateTenantId() }))
		}
		const page = await source.search({ query: 'RECORDED' })
		expect(page.matches).toEqual([])
		expect(page.incomplete).toBe(true)
		expect(page.unavailableRevisions).toContain(revision - 1)
		const read = await source.read({ revision, part: 0 })
		expect(read.entry).toBeNull()
		expect(read.unavailableRevisions).toContain(revision - 1)
	},
)

it('returns exact Unicode pages and rejects offsets that cut a surrogate pair', async () => {
	const f = await fixture()
	const text = `${'a'.repeat(5999)}😀${'b'.repeat(900)}`
	const revision = await f.step(text)
	const source = await f.history()
	const first = await source.read({ revision, part: 0 })
	expect(first.entry?.text).toHaveLength(5999)
	const second = await source.read({
		revision,
		part: 0,
		offset: first.entry?.nextOffset ?? undefined,
	})
	expect((first.entry?.text ?? '') + second.entry?.text).toBe(text)
	expect(second.entry?.nextOffset).toBeNull()
	await expect(source.read({ revision, part: 0, offset: 6000 })).rejects.toThrow('offset')
	await expect(source.read({ revision, part: 0, offset: text.length + 1 })).rejects.toThrow(
		'offset',
	)
	expect((await source.search({ query: '😀' })).matches[0]?.excerpt).toContain('😀')
})

it('honors cancellation and refuses out-of-range addresses without broadening the scope', async () => {
	const f = await fixture()
	const source = await f.history()
	const signal = AbortSignal.abort(new Error('Stop recall.'))
	await expect(source.search({}, signal)).rejects.toThrow('Stop recall')
	await expect(
		source.read({ revision: source.scope.throughRevision, part: 0 }, signal),
	).rejects.toThrow('Stop recall')
	await expect(source.search({ query: 'x'.repeat(257) })).rejects.toThrow()
	await expect(source.search({ limit: 9 })).rejects.toThrow()
	await expect(source.search({ cursor: 0 })).rejects.toThrow()
	expect((await source.search()).matches).toEqual([])
})
