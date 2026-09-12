import { randomUUID } from 'node:crypto'
import { Dir, type Dirent } from 'node:fs'
import { mkdir, mkdtemp, rename, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { RunDiscovery } from './run-discovery.js'

const roots: string[] = []
const readers: RunDiscovery[] = []
afterEach(async () => {
	for (const reader of readers.splice(0)) await reader.release()
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})
async function fixture(count = 205, now?: () => number) {
	const root = await mkdtemp(join(tmpdir(), 'namzu-run-discovery-'))
	roots.push(root)
	const path = join(root, 'runs')
	await mkdir(path)
	const ids = Array.from({ length: count }, () => randomUUID())
	for (const id of ids) await mkdir(join(path, id))
	const reader = new RunDiscovery(now)
	readers.push(reader)
	return { root, path, ids, reader }
}

it('pages every directory entry, caches concurrent continuation reads and closes at exhaustion', async () => {
	const f = await fixture()
	const close = vi.spyOn(Dir.prototype, 'close')
	const read = vi.spyOn(Dir.prototype, 'read')
	const first = await f.reader.read('scope', f.path)
	expect(first.runIds).toHaveLength(100)
	expect(read).toHaveBeenCalledTimes(100)
	const [second, repeated] = await Promise.all([
		f.reader.read('scope', f.path, first.next),
		f.reader.read('scope', f.path, first.next),
	])
	expect(second).toEqual(repeated)
	expect(read).toHaveBeenCalledTimes(200)
	second.runIds.length = 0
	expect((await f.reader.read('scope', f.path, first.next)).runIds).toHaveLength(100)
	const third = await f.reader.read('scope', f.path, repeated.next)
	expect(third.next).toBeUndefined()
	expect(third.runIds).toHaveLength(5)
	expect(new Set([...first.runIds, ...repeated.runIds, ...third.runIds])).toEqual(new Set(f.ids))
	expect(new Set(close.mock.contexts).size).toBe(1)
	await expect((close.mock.contexts[0] as Dir).read()).rejects.toThrow(/closed/i)
	await f.reader.release()
	expect(new Set(close.mock.contexts).size).toBe(1)
})

it('continues after an empty page and refuses a different scope or directory', async () => {
	const f = await fixture(0)
	for (let i = 0; i < 100; i++) await mkdir(join(f.path, `non-run-${i}`))
	const first = await f.reader.read('scope', f.path)
	expect(first.runIds).toEqual([])
	expect(first.next).toBeDefined()
	await expect(f.reader.read('foreign', f.path, first.next)).rejects.toThrow('scope')
	await expect(f.reader.read('scope', f.root, first.next)).rejects.toThrow('scope')
	expect(await f.reader.read('scope', f.path, first.next)).toEqual({ runIds: [] })
})

it.each(['append', 'replace', 'symlink'])(
	'refuses changed directory snapshots (%s)',
	async (change) => {
		const f = await fixture()
		const first = await f.reader.read('scope', f.path)
		if (change === 'append') await mkdir(join(f.path, randomUUID()))
		else {
			const old = join(f.root, 'old-runs')
			await rename(f.path, old)
			if (change === 'replace') await mkdir(f.path)
			else await symlink(old, f.path, 'dir')
		}
		await expect(f.reader.read('scope', f.path, first.next)).rejects.toThrow(/directory/i)
		await expect(f.reader.read('scope', f.path, first.next)).rejects.toThrow('expired')
	},
)

it('expires idle handles, releases one scope, and evicts the oldest of 32 scans', async () => {
	let now = 0
	const f = await fixture(100, () => now)
	const close = vi.spyOn(Dir.prototype, 'close')
	const first = await f.reader.read('first', f.path)
	await f.reader.read('second', f.path)
	await f.reader.release('second')
	expect(new Set(close.mock.contexts).size).toBe(1)
	for (let i = 0; i < 32; i++) await f.reader.read(`next-${i}`, f.path)
	expect(new Set(close.mock.contexts).size).toBe(2)
	await expect(f.reader.read('first', f.path, first.next)).rejects.toThrow('evicted')
	now += 10 * 60_000
	await expect(f.reader.read('first', f.path, first.next)).rejects.toThrow('expired')
	expect(new Set(close.mock.contexts).size).toBe(34)
	for (const directory of new Set(close.mock.contexts as Dir[]))
		await expect(directory.read()).rejects.toThrow(/closed/i)
})

it('closes a partially read directory on cancellation and admits a fresh search', async () => {
	const f = await fixture()
	const close = vi.spyOn(Dir.prototype, 'close')
	const controller = new AbortController()
	const read = Dir.prototype.read
	vi.spyOn(Dir.prototype, 'read').mockImplementationOnce(function (this: Dir) {
		controller.abort(new Error('cancel discovery'))
		return Reflect.apply(read, this, [])
	})
	await expect(f.reader.read('scope', f.path, undefined, controller.signal)).rejects.toThrow(
		'cancel discovery',
	)
	expect(new Set(close.mock.contexts).size).toBe(1)
	expect((await f.reader.read('scope', f.path)).runIds).toHaveLength(100)
})

it('bounds cached directory pages and rejects an evicted continuation', async () => {
	const f = await fixture(0)
	// Isolate cache pressure from filesystem size; real-directory paging is tested above.
	vi.spyOn(Dir.prototype, 'read').mockImplementation(() =>
		Promise.resolve({ name: 'noise' } as Dirent),
	)
	let page = await f.reader.read('scope', f.path)
	const oldest = page.next
	for (let i = 0; i < 129; i++) page = await f.reader.read('scope', f.path, page.next)
	await expect(f.reader.read('scope', f.path, oldest)).rejects.toThrow('evicted')
	expect((await f.reader.read('scope', f.path, page.next)).next).toBeDefined()
})
