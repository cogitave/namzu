import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { generateProjectId, generateSessionId, generateTenantId } from '../../utils/id.js'
import { DiskPalActivitySubscriptionStore } from './subscription-store.js'

const dirs: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(dirs)
	dirs.length = 0
})
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'namzu-subscription-list-'))
	dirs.push(home)
	const root = join(home, 'subscriptions')
	const store = new DiskPalActivitySubscriptionStore({ root })
	const tenantId = generateTenantId()
	const create = () =>
		store.create({
			id: randomUUID(),
			scope: {
				tenantId,
				projectId: generateProjectId(),
				palId: randomUUID(),
				profileRevision: 1,
				sessionId: generateSessionId(),
			},
			recipient: { tenantId, palId: randomUUID() },
			enabled: false,
		})
	return { home, root, store, create }
}
it('lists complete frozen latest records, including disabled rows, across fresh store instances', async () => {
	const f = await fixture()
	const first = await f.create()
	const second = await f.create()
	const latest = await f.store.setEnabled({ id: first.id, expectedRevision: 1, enabled: true })
	const emptyAllocationId = randomUUID()
	expect(await f.store.get(emptyAllocationId)).toBeNull()
	const rows = await new DiskPalActivitySubscriptionStore({ root: f.root }).list()
	expect(rows).toEqual([latest, second].sort((a, b) => a.id.localeCompare(b.id)))
	expect(Object.isFrozen(rows)).toBe(true)
	expect(rows.every((row) => Object.isFrozen(row) && Object.isFrozen(row.scope))).toBe(true)
})
it('returns an empty list when its previously allocated root is now absent', async () => {
	const f = await fixture()
	await rename(f.root, join(f.home, 'retired-subscriptions'))
	expect(await f.store.list()).toEqual([])
})
it('rejects the whole list when any committed row is malformed instead of losing that subscription', async () => {
	const f = await fixture()
	await f.create()
	const damaged = await f.create()
	const file = join(f.root, damaged.id, 'revisions', '1.json')
	const original = await readFile(file, 'utf8')
	await writeFile(file, 'PRIVATE_UNREADABLE_SUBSCRIPTION')
	await expect(f.store.list()).rejects.toThrow()
	await writeFile(file, original)
	expect(await f.store.list()).toHaveLength(2)
})
it('rejects an aliased subscription directory rather than reading the target as that identity', async () => {
	const f = await fixture()
	const record = await f.create()
	const location = join(f.root, record.id)
	const moved = join(f.home, 'aliased-record')
	await rename(location, moved)
	await symlink(moved, location, 'junction')
	await expect(f.store.list()).rejects.toThrow()
})
it('propagates an unreadable record even if other rows were already read', async () => {
	const f = await fixture()
	const rows = [await f.create(), await f.create()].sort((a, b) => a.id.localeCompare(b.id))
	const original = DiskRevisionRecordStore.prototype.read
	const failure = new Error('Record I/O refused')
	const last = rows[1]
	if (!last) throw new Error('Missing fixture row')
	vi.spyOn(DiskRevisionRecordStore.prototype, 'read').mockImplementation(function (
		this: DiskRevisionRecordStore<unknown>,
		location,
	) {
		if (location.revisionsDir === join(f.root, last.id, 'revisions')) return Promise.reject(failure)
		return original.call(this, location)
	})
	await expect(f.store.list()).rejects.toBe(failure)
})
