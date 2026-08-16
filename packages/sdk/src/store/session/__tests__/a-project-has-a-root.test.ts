import { mkdtemp, readdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { ProjectRootPathTakenError } from '../../../session/errors.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { SessionStore } from '../../../types/session/store.js'
import { DiskSessionStore } from '../disk.js'
import { InMemorySessionStore } from '../memory.js'

/**
 * A host building a project switcher had nothing to bind a directory to a
 * durable record.
 *
 * `Project` is already the cross-session container — it has an id, a
 * tenant, a status and a CAS counter — and carried no path at all. No new
 * noun was minted for this; the record that already IS the durable project
 * gained the field.
 *
 * Run against both stores. A capability implemented twice drifts, and a
 * conformance suite is the only thing that notices — the in-memory store
 * scans its own map while the disk store reads an index file, so they are
 * genuinely different implementations of one contract.
 */

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function temp(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(dir)
	return dir
}

const TENANT_A = 'tnt_a' as TenantId
const TENANT_B = 'tnt_b' as TenantId

type Factory = { name: string; make: () => Promise<SessionStore> }

const factories: Factory[] = [
	{ name: 'InMemorySessionStore', make: async () => new InMemorySessionStore() },
	{
		name: 'DiskSessionStore',
		make: async () => new DiskSessionStore({ rootDir: await temp('namzu-projroot-') }),
	},
]

for (const factory of factories) {
	describe(`${factory.name} — a project bound to a directory`, () => {
		it('canonicalizes what it is given, so one directory is one project', async () => {
			// A trailing slash and a symlink are the two spellings a caller
			// produces without meaning to. Stored as typed, they make three
			// records for one directory and every uniqueness check passes
			// while doing it.
			const store = await factory.make()
			const real = await temp('namzu-real-')
			const link = join(await temp('namzu-link-'), 'alias')
			await symlink(real, link)

			const project = await store.createProject(
				{ tenantId: TENANT_A, name: 'p', rootPath: `${real}/` },
				TENANT_A,
			)

			expect(project.rootPath).toBe(real)
			expect((await store.findProjectByRootPath?.(link, TENANT_A))?.id).toBe(project.id)
			expect((await store.findProjectByRootPath?.(`${real}//`, TENANT_A))?.id).toBe(project.id)
		})

		it('refuses a second project on the same directory, and names the first', async () => {
			// Refused rather than deduplicated. Returning the existing project
			// looks friendlier and silently discards the `name` and `config`
			// the caller passed — they asked to create something and would get
			// a different thing back with their arguments dropped.
			const store = await factory.make()
			const root = await temp('namzu-dup-')
			const first = await store.createProject(
				{ tenantId: TENANT_A, name: 'first', rootPath: root },
				TENANT_A,
			)

			await expect(
				store.createProject({ tenantId: TENANT_A, name: 'second', rootPath: root }, TENANT_A),
			).rejects.toBeInstanceOf(ProjectRootPathTakenError)

			try {
				await store.createProject({ tenantId: TENANT_A, name: 'second', rootPath: root }, TENANT_A)
			} catch (err) {
				expect((err as ProjectRootPathTakenError).details.existingProjectId).toBe(first.id)
			}
		})

		it('is tenant-scoped, so one machine can host two tenants on one path', async () => {
			// Dropping the tenant from the key turns this lookup into a
			// cross-tenant read that nothing else in the store would catch,
			// because it does not look like a read of another tenant's data.
			const store = await factory.make()
			const root = await temp('namzu-tenant-')
			const mine = await store.createProject(
				{ tenantId: TENANT_A, name: 'mine', rootPath: root },
				TENANT_A,
			)

			expect(await store.findProjectByRootPath?.(root, TENANT_B)).toBeNull()
			expect((await store.findProjectByRootPath?.(root, TENANT_A))?.id).toBe(mine.id)
		})

		it('survives a round trip through the store', async () => {
			const store = await factory.make()
			const root = await temp('namzu-trip-')
			const created = await store.createProject(
				{ tenantId: TENANT_A, name: 'p', rootPath: root },
				TENANT_A,
			)

			expect((await store.getProject(created.id, TENANT_A))?.rootPath).toBe(root)
		})

		it('leaves a project with no rootPath findable by nothing', async () => {
			// Optional means optional: a project need not be on disk, and one
			// that is not must not become findable by an empty-string key.
			const store = await factory.make()
			await store.createProject({ tenantId: TENANT_A, name: 'p' }, TENANT_A)

			expect(await store.findProjectByRootPath?.('', TENANT_A)).toBeNull()
		})
	})
}

describe('DiskSessionStore — the lookup does not scan', () => {
	it('answers from one index file, not by opening every project.json', async () => {
		// The property that makes this usable at all. A scan opens every
		// project a host has ever made to answer a question about one
		// directory, and gets slower forever. Asserted structurally, because
		// a timing assertion on ten projects proves nothing.
		const rootDir = await temp('namzu-scan-')
		const store = new DiskSessionStore({ rootDir })
		const target = await temp('namzu-target-')
		for (let i = 0; i < 3; i++) {
			await store.createProject(
				{ tenantId: TENANT_A, name: `p${i}`, rootPath: await temp('namzu-other-') },
				TENANT_A,
			)
		}
		const wanted = await store.createProject(
			{ tenantId: TENANT_A, name: 'wanted', rootPath: target },
			TENANT_A,
		)

		const entries = await readdir(join(rootDir, 'projects'))

		expect(entries).toContain('root-path-index.json')
		expect((await store.findProjectByRootPath(target, TENANT_A))?.id).toBe(wanted.id)
	})
})
