import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { ProjectId, TenantId } from '../../../types/ids/index.js'
import { SCHEMA_VERSION_KEY } from '../../schema.js'
import { DiskSessionStore } from '../disk.js'

/**
 * The two largest stores stopped hand-rolling read, write and scan.
 *
 * A conversion like this is only safe if the new reader accepts exactly
 * what the old writer produced — and the old writer is gone, so a test that
 * round-trips through the NEW code proves nothing about the trees already
 * on disk in every checkout and every container. These fixtures are written
 * by hand in the old shape, byte for byte, and read back through the
 * converted store.
 *
 * The properties that had to survive are the ones no signature carries: a
 * missing file reads as absent rather than throwing, a listing has a stable
 * order, and a record from a NEWER build is refused instead of read
 * partially and written back with the difference gone.
 */

const TENANT = 'tnt_conv' as TenantId

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

/** The exact bytes the previous `atomicWriteJson` produced: 2-space, no trailing newline. */
async function oldWrite(path: string, value: unknown, version = 3): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true })
	// Through the exported key, never a literal. A fixture that stamps the
	// wrong property name is stamped with NOTHING — the record reads as
	// unversioned, the assertion holds for a reason that has nothing to do
	// with what it claims, and the test passes forever.
	await writeFile(
		path,
		JSON.stringify({ ...(value as object), [SCHEMA_VERSION_KEY]: version }, null, 2),
	)
}

async function fixtureRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-conv-'))
	dirs.push(root)
	return root
}

function projectRecord(id: string, name: string, createdAt: number) {
	return {
		id,
		name,
		tenantId: TENANT,
		createdAt: new Date(createdAt).toISOString(),
		updatedAt: new Date(createdAt).toISOString(),
	}
}

describe('the converted store reads what the old writer wrote', () => {
	it('reads a project record written in the old byte layout', async () => {
		// No trailing newline, which the primitive now adds on write. A reader
		// that had come to depend on the newline would fail here and only
		// here — every round-trip through the new code would pass.
		const root = await fixtureRoot()
		await oldWrite(join(root, 'projects', 'prj_a', 'project.json'), projectRecord('prj_a', 'A', 1))

		const store = new DiskSessionStore({ rootDir: root })
		const project = await store.getProject('prj_a' as ProjectId, TENANT)

		expect(project?.name).toBe('A')
	})

	it('lists old-layout projects by creation time, whatever order they sit in', async () => {
		// The store's OWN sort, not the scan's. A first version of this
		// claimed to pin the primitive's stable ordering and did not:
		// reversing the sort inside `scanNames` leaves this green, because
		// `listProjects` re-sorts by `createdAt` afterwards. The scan's order
		// is asserted where it lives, in the record-store's own tests.
		//
		// Written out of order on purpose so the sort has something to do.
		const root = await fixtureRoot()
		for (const [id, name, t] of [
			['prj_c', 'C', 3],
			['prj_a', 'A', 1],
			['prj_b', 'B', 2],
		] as const) {
			await oldWrite(join(root, 'projects', id, 'project.json'), projectRecord(id, name, t))
		}

		const store = new DiskSessionStore({ rootDir: root })
		const listed = await store.listProjects(TENANT)

		expect(listed.map((p) => p.id)).toEqual(['prj_a', 'prj_b', 'prj_c'])
	})

	it('treats an absent tree as empty rather than an error', async () => {
		// "Nothing has been written yet" is an ordinary state of a store, not
		// a failure — the convention every hand-rolled copy arrived at
		// independently and the one most at risk in a conversion.
		const store = new DiskSessionStore({ rootDir: await fixtureRoot() })

		await expect(store.listProjects(TENANT)).resolves.toEqual([])
		await expect(store.getProject('prj_missing' as ProjectId, TENANT)).resolves.toBeNull()
	})

	it('still refuses a record from a newer build', async () => {
		// The property with the worst failure mode and the least visible
		// symptom. Reading a future record partially and writing it back
		// drops whatever the newer build added — silently, permanently, and
		// only for the users who ran both builds. It has to survive the
		// conversion, and nothing about a read signature says it does.
		const root = await fixtureRoot()
		await oldWrite(
			join(root, 'projects', 'prj_future', 'project.json'),
			projectRecord('prj_future', 'F', 1),
			999,
		)

		const store = new DiskSessionStore({ rootDir: root })

		await expect(store.getProject('prj_future' as ProjectId, TENANT)).rejects.toThrow(
			/schema|version/i,
		)
	})
})
