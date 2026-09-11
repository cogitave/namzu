import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda, type ResidentPursuit } from './agenda.js'
import type { ResidentMessageInput } from './outbox.js'
import type { ResidentProposal } from './proposal.js'
import { ResidentConflictError } from './store.js'

const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function state(agenda: DiskResidentAgenda) {
	const snapshot = await agenda.read()
	if (!snapshot) throw new Error('Missing fixture agenda')
	return snapshot
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-archive-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'archive-test' }
	const agenda = new DiskResidentAgenda(root, scope)
	await agenda.create('Careful resident')
	return {
		root,
		scope,
		agenda,
		reopen: () => new DiskResidentAgenda(root, scope),
		path: (revision: number) =>
			join(root, scope.tenantId, scope.agentKey, 'agenda', 'revisions', `${revision}.json`),
	}
}
async function finish(agenda: DiskResidentAgenda, pursuit: ResidentPursuit) {
	const execution = agenda.execution(pursuit.id)
	const claim = await execution.claim(pursuit.state, 1_000)
	await execution.settle(claim, { kind: 'complete', summary: 'Verified' }, 1_000)
}
async function completed(agenda: DiskResidentAgenda, objective = 'Inspect fixture') {
	const pursuit = await agenda.add(await state(agenda), objective)
	await finish(agenda, pursuit)
	const saved = (await state(agenda)).pursuits.find((p) => p.id === pursuit.id)
	if (!saved) throw new Error('Missing completed fixture pursuit')
	return saved
}
function input(pursuit: ResidentPursuit): ResidentMessageInput {
	return {
		id: randomUUID(),
		pursuitId: pursuit.id,
		destination: 'local',
		body: 'Verified result',
		notBefore: 0,
	}
}
async function acknowledge(agenda: DiskResidentAgenda, message: ResidentMessageInput) {
	await agenda.enqueueMessage(await state(agenda), message)
	const claimed = await agenda.claimMessage(await state(agenda), message.id, 1_000)
	await agenda.settleMessage(claimed, { kind: 'acknowledged', receiptId: 'local:accepted' }, 1_000)
}
function proposal(parent: ResidentPursuit): ResidentProposal {
	return {
		id: randomUUID(),
		parentId: parent.id,
		parentRevision: parent.state.revision,
		domain: 'research',
		objective: 'Review one finding',
		reason: 'Observed gap',
		evidenceKey: randomUUID(),
	}
}
const limits = { domains: ['research'], maxChildrenPerParent: 2, maxDepth: 4 }

it('archives terminal intent and pursuit together while retained history prevents redelivery', async () => {
	const f = await fixture()
	const pursuit = await completed(f.agenda)
	const message = input(pursuit)
	await acknowledge(f.agenda, message)
	const before = await state(f.agenda)
	const archived = await f.agenda.archive(before, {
		pursuitIds: [pursuit.id],
		messageIds: [message.id],
	})
	expect(archived).toMatchObject({ pursuits: [], outbox: [], archiveHead: before.revision + 1 })
	const reopened = f.reopen()
	expect(await reopened.readRevision(before.revision)).toEqual(before)
	const page = await reopened.listArchived()
	expect(page.entries).toHaveLength(1)
	expect(page.entries[0]).toMatchObject({
		revision: archived.revision,
		pursuits: [{ id: pursuit.id }],
		messages: [{ id: message.id, phase: 'acknowledged' }],
	})
	expect(page.nextBeforeRevision).toBeNull()
	expect(Object.isFrozen(page.entries[0]?.messages)).toBe(true)
	const duplicate = await reopened.enqueueMessage(await state(reopened), message)
	expect(duplicate).toMatchObject({ id: message.id, phase: 'acknowledged', attempts: 1 })
	expect((await state(reopened)).outbox).toEqual([])
	await expect(
		reopened.enqueueMessage(await state(reopened), { ...message, body: 'Changed' }),
	).rejects.toThrow('different immutable archived intent')
})

it('frees the pursuit capacity without discarding history', async () => {
	const f = await fixture()
	const first = await completed(f.agenda)
	for (let i = 0; i < 31; i++) await f.agenda.add(await state(f.agenda), `Remaining ${i}`)
	await expect(f.agenda.add(await state(f.agenda), 'Over capacity')).rejects.toThrow()
	await f.agenda.archive(await state(f.agenda), { pursuitIds: [first.id] })
	await f.agenda.add(await state(f.agenda), 'New pursuit')
	expect((await state(f.agenda)).pursuits).toHaveLength(32)
	expect((await f.agenda.listArchived()).entries[0]?.pursuits[0]?.id).toBe(first.id)
})

it('retains lifetime child bounds and proposal dedup after children are archived', async () => {
	const f = await fixture()
	const parent = await completed(f.agenda)
	const original = proposal(parent)
	for (const requested of [original, proposal(parent)]) {
		const child = await f.agenda.admitProposal(await state(f.agenda), requested, limits)
		await finish(f.agenda, child)
		await f.agenda.archive(await state(f.agenda), { pursuitIds: [child.id] })
	}
	const reopened = f.reopen()
	expect((await state(reopened)).pursuits).toMatchObject([{ id: parent.id, retiredChildren: 2 }])
	await expect(
		reopened.admitProposal(await state(reopened), proposal(parent), limits),
	).rejects.toThrow('child bound')
	await expect(
		reopened.admitProposal(await state(reopened), original, { ...limits, maxChildrenPerParent: 8 }),
	).rejects.toThrow('already been admitted and archived')
	const third = await reopened.admitProposal(await state(reopened), proposal(parent), {
		...limits,
		maxChildrenPerParent: 3,
	})
	expect(third.origin?.depth).toBe(1)
})

it('requires terminal closed sets for parents, descendants and messages', async () => {
	const f = await fixture()
	const parent = await completed(f.agenda)
	const child = await f.agenda.admitProposal(await state(f.agenda), proposal(parent), limits)
	const before = await state(f.agenda)
	await expect(f.agenda.archive(before, { pursuitIds: [parent.id] })).rejects.toThrow('parents')
	await expect(f.agenda.archive(before, { pursuitIds: [child.id] })).rejects.toThrow(
		'terminal pursuits',
	)
	await finish(f.agenda, child)
	const message = input(child)
	await f.agenda.enqueueMessage(await state(f.agenda), message)
	await expect(f.agenda.archive(await state(f.agenda), { pursuitIds: [child.id] })).rejects.toThrow(
		'referenced',
	)
	await expect(
		f.agenda.archive(await state(f.agenda), { messageIds: [message.id] }),
	).rejects.toThrow('terminal messages')
	const claim = await f.agenda.claimMessage(await state(f.agenda), message.id, 1_000)
	await expect(
		f.agenda.archive(await state(f.agenda), { messageIds: [message.id] }),
	).rejects.toThrow('terminal messages')
	await f.agenda.settleMessage(
		claim,
		{ kind: 'not-accepted', retryAt: null, reason: 'Not needed' },
		1_000,
	)
	await f.agenda.archive(await state(f.agenda), {
		pursuitIds: [parent.id, child.id],
		messageIds: [message.id],
	})
	expect((await state(f.agenda)).pursuits).toEqual([])
	expect((await f.agenda.listArchived()).entries[0]?.pursuits).toHaveLength(2)
})

it('pages only archive events while ordinary revisions preserve the chain', async () => {
	const f = await fixture()
	const first = await completed(f.agenda)
	const oldest = await f.agenda.archive(await state(f.agenda), { pursuitIds: [first.id] })
	await f.agenda.setPaused(await state(f.agenda), true)
	await f.agenda.setPaused(await state(f.agenda), false)
	const second = await completed(f.agenda)
	const newest = await f.agenda.archive(await state(f.agenda), { pursuitIds: [second.id] })
	expect(oldest).not.toHaveProperty('pauseGeneration')
	expect(newest.pauseGeneration).toBe(1)
	await f.agenda.add(await state(f.agenda), 'Keep working')
	expect((await state(f.reopen())).pauseGeneration).toBe(1)
	expect((await f.reopen().readRevision(newest.revision))?.pauseGeneration).toBe(1)
	const read = vi.spyOn(f.agenda, 'readRevision')
	const firstPage = await f.agenda.listArchived({ limit: 1 })
	expect(read).toHaveBeenCalledTimes(2)
	expect(firstPage.entries[0]?.revision).toBe(newest.revision)
	expect(firstPage.nextBeforeRevision).toBe(oldest.revision)
	const lastPage = await f.agenda.listArchived({ beforeRevision: oldest.revision, limit: 1 })
	expect(lastPage.entries[0]?.revision).toBe(oldest.revision)
	expect(lastPage.nextBeforeRevision).toBeNull()
	await expect(f.agenda.listArchived({ limit: 33 })).rejects.toThrow()
	await expect(f.agenda.listArchived({ beforeRevision: newest.revision + 1 })).rejects.toThrow(
		'ahead',
	)
})

it('binds archive and historical dedup checks to the final agenda CAS', async () => {
	const f = await fixture()
	const pursuit = await completed(f.agenda)
	const message = input(pursuit)
	await acknowledge(f.agenda, message)
	const before = await state(f.agenda)
	const outcomes = await Promise.allSettled([
		f.agenda.archive(before, { messageIds: [message.id] }),
		f.reopen().archive(before, { messageIds: [message.id] }),
	])
	expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
	const read = f.agenda.readRevision.bind(f.agenda)
	vi.spyOn(f.agenda, 'readRevision').mockImplementationOnce(async (revision) => {
		const historical = await read(revision)
		await f.agenda.add(await state(f.agenda), 'Concurrent addition')
		return historical
	})
	await expect(f.agenda.enqueueMessage(await state(f.agenda), message)).rejects.toThrow(
		ResidentConflictError,
	)
	expect((await state(f.agenda)).outbox).toEqual([])
})

it('fails closed on missing or mismatched immutable history', async () => {
	const f = await fixture()
	const pursuit = await completed(f.agenda)
	const before = await state(f.agenda)
	await f.agenda.archive(before, { pursuitIds: [pursuit.id] })
	await unlink(f.path(before.revision))
	await expect(f.agenda.listArchived()).rejects.toThrow('missing')
	const current = await f.agenda.add(await state(f.agenda), 'Current pursuit')
	await expect(f.agenda.enqueueMessage(await state(f.agenda), input(current))).rejects.toThrow(
		'missing',
	)
	const live = await state(f.agenda)
	const raw = JSON.parse(await readFile(f.path(live.revision), 'utf8'))
	await writeFile(f.path(live.revision), JSON.stringify({ ...raw, revision: live.revision + 1 }))
	await expect(f.agenda.readRevision(live.revision)).rejects.toThrow('filename')
})

it('preserves learning and rejects empty, duplicate, unknown and stale archive requests', async () => {
	const f = await fixture()
	const pursuit = await completed(f.agenda)
	const corrected = await f.agenda.updateProfile(await state(f.agenda), {
		identity: 'Careful reviewer',
		evidence: { key: 'profile:1', source: 'host', reason: 'Clarified role' },
	})
	for (const request of [
		{},
		{ pursuitIds: [pursuit.id, pursuit.id] },
		{ pursuitIds: [randomUUID()] },
	])
		await expect(f.agenda.archive(corrected, request)).rejects.toThrow()
	const archived = await f.agenda.archive(corrected, { pursuitIds: [pursuit.id] })
	expect(archived.learning).toEqual(corrected.learning)
	await expect(f.agenda.archive(corrected, { pursuitIds: [pursuit.id] })).rejects.toThrow(
		ResidentConflictError,
	)
	expect((await f.reopen().listArchived()).entries[0]?.pursuits[0]?.id).toBe(pursuit.id)
})
