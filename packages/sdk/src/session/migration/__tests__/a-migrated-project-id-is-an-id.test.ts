import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { ProjectIdSchema } from '../../../contracts/schemas.js'
import { FilesystemMigrationError } from '../errors.js'
import { DefaultFilesystemMigrator, NOOP_FILESYSTEM_MIGRATION_SINK } from '../filesystem.js'

/**
 * The v0.2.0 migration is the only place a `ProjectId` is built from data
 * instead of generated: it takes a legacy `thd_*` folder name off disk and
 * mints `prj_legacy_<that name>`. The only check the name had passed was
 * `startsWith('thd_')`, so a folder named `thd_Not An Id` produced a project
 * id that satisfies the TypeScript type, is written into the new layout as a
 * directory name, and is rejected by the SDK's own `ProjectIdSchema`.
 *
 * It refuses such a folder rather than skipping it. Skipping would leave that
 * thread's runs on disk and unaddressable, write the completion marker anyway,
 * and return `kind: 'migrated'` with the thread missing from the list — the
 * failure shape this codebase keeps meeting, where the run did not fail, it
 * succeeded while quietly not doing what it said.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function seed(root: string, folder: string): Promise<void> {
	const dir = join(root, 'threads', folder, 'runs', 'run_seed')
	await mkdir(dir, { recursive: true })
	await writeFile(join(dir, 'run.json'), JSON.stringify({ id: 'run_seed' }), 'utf-8')
}

async function newRoot(tag: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `namzu-mig-${tag}-`))
	dirs.push(root)
	return root
}

describe('the migration only mints project ids that are project ids', () => {
	it('refuses a legacy folder whose name is not a thread id, and names it', async () => {
		const root = await newRoot('badname')
		await seed(root, 'thd_Not An Id')

		const error = await new DefaultFilesystemMigrator(NOOP_FILESYSTEM_MIGRATION_SINK)
			.migrate(root)
			.then(
				() => null,
				(e: unknown) => e,
			)

		expect(error).toBeInstanceOf(FilesystemMigrationError)
		const details = (error as FilesystemMigrationError).details
		expect(details.op).toBe('validate_thread_id')
		// An operator has to be able to go and look at the folder.
		expect(details.path).toContain('thd_Not An Id')
	})

	it('refuses rather than reporting a migration that left a thread behind', async () => {
		// The seductive alternative is `continue`. This pins why it is wrong:
		// the good thread would migrate, the result would say `migrated`, and
		// the bad one would be absent from `migratedThreads` with no error.
		const root = await newRoot('partial')
		await seed(root, 'thd_a1b2c3d4e5f6')
		await seed(root, 'thd_UPPER')

		await expect(
			new DefaultFilesystemMigrator(NOOP_FILESYSTEM_MIGRATION_SINK).migrate(root),
		).rejects.toBeInstanceOf(FilesystemMigrationError)
	})

	it('still migrates a folder whose name is a thread id, and the id it mints validates', async () => {
		// The guard must refuse only what is not an id. A guard that refuses
		// everything passes the two cases above and breaks migration entirely.
		const root = await newRoot('good')
		await seed(root, 'thd_a1b2c3d4e5f6')

		const result = await new DefaultFilesystemMigrator(NOOP_FILESYSTEM_MIGRATION_SINK).migrate(root)

		expect(result.kind).toBe('migrated')
		expect(result.migratedThreads.map((m) => m.legacyThreadId)).toEqual(['thd_a1b2c3d4e5f6'])
		for (const { newProjectId } of result.migratedThreads) {
			expect({ newProjectId, ok: ProjectIdSchema.safeParse(newProjectId).success }).toEqual({
				newProjectId,
				ok: true,
			})
		}
	})
})
