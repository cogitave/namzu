import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', async () => {
	const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
	return { ...real, readdir: vi.fn(real.readdir) }
})

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { SCHEMA_VERSION_KEY, defineSchema } from '../../schema.js'
import { DiskRecordStore } from '../record-store.js'

/**
 * Four disk stores each carried a private copy of the same twenty lines.
 *
 * The properties they duplicated are not obvious ones — a missing file is
 * an empty read rather than an error, a record from a NEWER build is
 * refused rather than read partially and written back with the difference
 * gone, a listing needs a stable order because `readdir` does not have
 * one. Each copy had to remember all of them, and a fix in one of them was
 * a fix in one of them.
 *
 * These are those properties, asserted once.
 */

interface Thing {
	readonly id: string
	readonly label: string
}

const SCHEMA = defineSchema({ kind: 'test-thing', current: 2, migrations: { 1: (r) => r } })

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-kv-'))
	dirs.push(dir)
	return dir
}

describe('reading a record', () => {
	it('answers null for a file that is not there', async () => {
		// The convention every copy already used, and the reason to state it
		// once: a store that signalled absence by throwing would make every
		// caller distinguish ENOENT from a real IO failure, and the copies
		// that got that right did so independently.
		const store = new DiskRecordStore<Thing>(SCHEMA)

		expect(await store.read(join(await tempDir(), 'nope.json'))).toBeNull()
	})

	it('still throws for a failure that is not absence', async () => {
		// The other half. Collapsing every error to null would turn a
		// permission problem or a corrupt file into "nothing here yet".
		const dir = await tempDir()
		const path = join(dir, 'broken.json')
		await writeFile(path, '{ not json')

		await expect(new DiskRecordStore<Thing>(SCHEMA).read(path)).rejects.toThrow()
	})

	it('round-trips a record through the schema', async () => {
		const store = new DiskRecordStore<Thing>(SCHEMA)
		const path = join(await tempDir(), 'thing.json')

		await store.write(path, { id: 'a', label: 'one' })

		expect(await store.read(path)).toMatchObject({ id: 'a', label: 'one' })
	})

	it('refuses a record written by a NEWER build', async () => {
		// Not a cast. A record stamped ahead of this build has fields this
		// code cannot see, and reading it partially then writing it back
		// deletes them — silently, and only for the users who upgraded last.
		const dir = await tempDir()
		const path = join(dir, 'future.json')
		// Through the exported constant, not a literal. Writing `__schemaVersion`
		// by hand — which is what this test did first — stamps nothing, the
		// record reads as unversioned, and the test passes while asserting
		// nothing at all.
		await writeFile(path, JSON.stringify({ id: 'a', label: 'one', [SCHEMA_VERSION_KEY]: 99 }))

		await expect(new DiskRecordStore<Thing>(SCHEMA).read(path)).rejects.toThrow()
	})
})

describe('scanning a directory', () => {
	it('lists nothing for a directory that does not exist', async () => {
		// Same reasoning as a missing file: "nothing written yet" is an
		// ordinary state of a store, not a failure.
		const store = new DiskRecordStore<Thing>(SCHEMA)

		expect(await store.scanNames(join(await tempDir(), 'absent'), 'thg_')).toEqual([])
	})

	it('filters by prefix', async () => {
		const dir = await tempDir()
		for (const name of ['thg_c', 'thg_a', 'other_z', 'thg_b']) {
			await mkdir(join(dir, name), { recursive: true })
		}
		const store = new DiskRecordStore<Thing>(SCHEMA)

		expect(await store.scanNames(dir, 'thg_')).toEqual(['thg_a', 'thg_b', 'thg_c'])
	})

	it('sorts what readdir hands back, whatever order that is', async () => {
		// `readdir` is STUBBED here, and it has to be. Creating the
		// directories and trusting the filesystem to return them unsorted is
		// what this test did first — and on this machine `readdir` happened
		// to answer in order, so deleting the `.sort()` left it green. A
		// property that only holds on some filesystems cannot be checked by
		// using the filesystem.
		const stub = vi.mocked(readdir)
		stub.mockResolvedValueOnce(['thg_c', 'other_z', 'thg_a', 'thg_b'] as never)

		const names = await new DiskRecordStore<Thing>(SCHEMA).scanNames('/anywhere', 'thg_')

		expect(names).toEqual(['thg_a', 'thg_b', 'thg_c'])
	})

	it('skips an entry whose record is missing rather than failing the listing', async () => {
		// A half-written entry from a crashed writer must not make every
		// other record unreachable.
		const dir = await tempDir()
		const store = new DiskRecordStore<Thing>(SCHEMA)
		await mkdir(join(dir, 'thg_a'), { recursive: true })
		await mkdir(join(dir, 'thg_b'), { recursive: true })
		await store.write(join(dir, 'thg_a', 'record.json'), { id: 'a', label: 'one' })

		const seen: Thing[] = []
		for await (const record of store.scan(dir, 'thg_')) seen.push(record)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.id).toBe('a')
	})
})
