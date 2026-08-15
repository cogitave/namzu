import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'

import {
	DefaultFilesystemMigrator,
	NOOP_FILESYSTEM_MIGRATION_SINK,
} from '../../session/migration/filesystem.js'
import { generateProjectId } from '../../utils/id.js'
import { ProjectIdSchema } from '../schemas.js'

/**
 * `ProjectIdSchema` was `/^prj_[a-z0-9]+$/` while the v0.2.0 filesystem
 * migration minted `prj_legacy_<suffix>`. So the SDK's own public validator
 * rejected ids the SDK itself had written to disk: a host that validated an
 * inbound project id — the reason the schema is exported at all — refused
 * every project it had migrated, with "Invalid project ID format" and no hint
 * that the id came from the SDK.
 *
 * Both minters are driven here rather than restated. A test that spells out
 * `prj_legacy_abc` as a literal would still pass if the migration changed its
 * shape tomorrow; running the migration means the two cannot drift apart
 * without this failing.
 */

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

describe('every project id the SDK mints passes the schema the SDK exports', () => {
	it('accepts what the id generator produces', () => {
		// 200 draws, because the generator is random over [0-9a-z] and one
		// sample proves nothing about the alphabet it can reach.
		for (let i = 0; i < 200; i++) {
			const id = generateProjectId()
			const parsed = ProjectIdSchema.safeParse(id)
			expect({ id, ok: parsed.success }).toEqual({ id, ok: true })
		}
	})

	it('accepts what the filesystem migration produces', async () => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-idschema-'))
		dirs.push(root)
		const runDir = join(root, 'threads', 'thd_a1b2c3d4e5f6', 'runs', 'run_seed')
		await mkdir(runDir, { recursive: true })
		await writeFile(join(runDir, 'run.json'), JSON.stringify({ id: 'run_seed' }), 'utf-8')

		const result = await new DefaultFilesystemMigrator(NOOP_FILESYSTEM_MIGRATION_SINK).migrate(root)

		expect(result.kind).toBe('migrated')
		expect(result.migratedThreads).toHaveLength(1)
		for (const { newProjectId } of result.migratedThreads) {
			const parsed = ProjectIdSchema.safeParse(newProjectId)
			expect({ newProjectId, ok: parsed.success }).toEqual({ newProjectId, ok: true })
		}
	})

	it('still refuses what no minter produces, because the id is also a directory name', () => {
		// Widening to accept the legacy form must not widen to accept a path.
		// Everything here would be joined onto the store root if it got through.
		const refused = [
			'prj_../../etc',
			'prj_..',
			'prj_a/b',
			'prj_a\\b',
			'prj_',
			'prj_legacy_',
			'prj_ABC',
			'prj_a-b',
			'prj_a b',
			'proj_abc',
			'thd_abc',
			// NZ-TOPIC-04: the live Topic layer's own prefix must be exactly as
			// unwelcome here as the legacy container's — this schema names
			// Project ids, not Topic ids, and the two must never be mistaken
			// for one another at the validation boundary.
			'top_abc',
			'',
		]

		for (const candidate of refused) {
			const parsed = ProjectIdSchema.safeParse(candidate)
			expect({ candidate, ok: parsed.success }).toEqual({ candidate, ok: false })
		}
	})
})
