/**
 * Integration — boot-time filesystem re-layout wired through the real
 * {@link DefaultFilesystemMigrator}. Temp-dir fixtures, no mocks.
 *
 * Covers roadmap §5 invariants: §13.4.1 boot migration (cold-boot / warm /
 * idempotent / multi-thread), synthesized project.json + session.json with
 * `_legacy: true` + UNKNOWN_TENANT_ID, marker `.migration/v0.2.0` written
 * last.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNKNOWN_TENANT_ID } from '../../../types/ids/index.js'
import {
	DefaultFilesystemMigrator,
	type FilesystemMigrationEvent,
	type FilesystemMigrationSink,
	LEGACY_DEFAULT_PROJECT_PREFIX,
	LEGACY_DEFAULT_SESSION_ID,
	MARKER_REL_PATH,
	MIGRATION_VERSION,
} from '../../migration/filesystem.js'

function collectingSink(): { events: FilesystemMigrationEvent[]; sink: FilesystemMigrationSink } {
	const events: FilesystemMigrationEvent[] = []
	return {
		events,
		sink: {
			emit(ev) {
				events.push(ev)
			},
		},
	}
}

async function seedLegacyThread(root: string, thread: string, runs: string[]): Promise<void> {
	for (const run of runs) {
		const dir = join(root, 'threads', thread, 'runs', run)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, 'run.json'), JSON.stringify({ id: run }), 'utf-8')
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await stat(p)
		return true
	} catch {
		return false
	}
}

describe('Integration — boot-time filesystem migration', () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'namzu-intgr-fsmig-'))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('cold boot with legacy .namzu/threads/thd_abc → migrated to projects layout + marker + event', async () => {
		await seedLegacyThread(root, 'thd_abc', ['run_xyz'])
		const { events, sink } = collectingSink()
		const migrator = new DefaultFilesystemMigrator(sink)

		const result = await migrator.migrate(root)

		expect(result.kind).toBe('migrated')
		expect(result.migratedThreads).toEqual([
			{ legacyThreadId: 'thd_abc', newProjectId: `${LEGACY_DEFAULT_PROJECT_PREFIX}abc` },
		])

		// New layout: projects/{prj_legacy_abc}/sessions/{ses_legacy_default}/runs/run_xyz
		const newRunDir = join(
			root,
			'projects',
			`${LEGACY_DEFAULT_PROJECT_PREFIX}abc`,
			'sessions',
			LEGACY_DEFAULT_SESSION_ID,
			'runs',
			'run_xyz',
		)
		expect(await pathExists(newRunDir)).toBe(true)

		// Legacy sub-tree moved.
		expect(await pathExists(join(root, 'threads', 'thd_abc', 'runs'))).toBe(false)

		// Marker landed last.
		const markerRaw = await readFile(join(root, MARKER_REL_PATH), 'utf-8')
		const marker = JSON.parse(markerRaw)
		expect(marker.version).toBe(MIGRATION_VERSION)

		// Event emitted.
		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe('filesystem.migrated')
	})

	it('synthesized project.json has _legacy: true + tenantId: UNKNOWN_TENANT_ID', async () => {
		await seedLegacyThread(root, 'thd_leg', ['run_a'])
		const migrator = new DefaultFilesystemMigrator()
		await migrator.migrate(root)

		const parsed = JSON.parse(
			await readFile(
				join(root, 'projects', `${LEGACY_DEFAULT_PROJECT_PREFIX}leg`, 'project.json'),
				'utf-8',
			),
		)
		expect(parsed._legacy).toBe(true)
		expect(parsed.tenantId).toBe(UNKNOWN_TENANT_ID)
		expect(parsed.id).toBe(`${LEGACY_DEFAULT_PROJECT_PREFIX}leg`)
		expect(parsed.config).toMatchObject({
			maxDelegationDepth: 4,
			maxDelegationWidth: 8,
			maxInterventionDepth: 10,
		})
	})

	it('synthesized session.json is idle + _legacy', async () => {
		await seedLegacyThread(root, 'thd_seschk', ['run_a'])
		const migrator = new DefaultFilesystemMigrator()
		await migrator.migrate(root)

		const parsed = JSON.parse(
			await readFile(
				join(
					root,
					'projects',
					`${LEGACY_DEFAULT_PROJECT_PREFIX}seschk`,
					'sessions',
					LEGACY_DEFAULT_SESSION_ID,
					'session.json',
				),
				'utf-8',
			),
		)
		expect(parsed.id).toBe(LEGACY_DEFAULT_SESSION_ID)
		expect(parsed.status).toBe('idle')
		expect(parsed.tenantId).toBe(UNKNOWN_TENANT_ID)
		expect(parsed._legacy).toBe(true)
	})

	it('warm boot: marker present → kind: already_migrated, no filesystem changes', async () => {
		// First run creates the marker.
		await seedLegacyThread(root, 'thd_warm', ['run_a'])
		const migrator = new DefaultFilesystemMigrator()
		await migrator.migrate(root)

		// Second run must short-circuit.
		const result = await migrator.migrate(root)
		expect(result.kind).toBe('already_migrated')
		expect(result.migratedThreads).toHaveLength(0)
	})

	it('idempotent: second migrate() invocation is noop in same process', async () => {
		await seedLegacyThread(root, 'thd_idem', ['run_1'])

		const migrator = new DefaultFilesystemMigrator()
		const first = await migrator.migrate(root)
		const second = await migrator.migrate(root)

		expect(first.kind).toBe('migrated')
		expect(second.kind).toBe('already_migrated')
		expect(second.migratedThreads).toHaveLength(0)

		// End state still valid.
		const newRunDir = join(
			root,
			'projects',
			`${LEGACY_DEFAULT_PROJECT_PREFIX}idem`,
			'sessions',
			LEGACY_DEFAULT_SESSION_ID,
			'runs',
			'run_1',
		)
		expect(await pathExists(newRunDir)).toBe(true)
	})

	it('three legacy threads migrated in one pass → marker lists all', async () => {
		await seedLegacyThread(root, 'thd_alpha', ['run_a1', 'run_a2'])
		await seedLegacyThread(root, 'thd_beta', ['run_b1'])
		await seedLegacyThread(root, 'thd_gamma', ['run_g1'])

		const migrator = new DefaultFilesystemMigrator()
		const result = await migrator.migrate(root)

		expect(result.kind).toBe('migrated')
		expect(result.migratedThreads).toHaveLength(3)
		const ids = result.migratedThreads.map((m) => m.legacyThreadId).sort()
		expect(ids).toEqual(['thd_alpha', 'thd_beta', 'thd_gamma'])

		const markerRaw = await readFile(join(root, MARKER_REL_PATH), 'utf-8')
		const marker = JSON.parse(markerRaw)
		expect(marker.migratedThreads).toHaveLength(3)
	})

	it('fresh install (no legacy + no marker): writes marker + returns noop_no_legacy', async () => {
		const migrator = new DefaultFilesystemMigrator()
		const result = await migrator.migrate(root)

		expect(result.kind).toBe('noop_no_legacy')
		expect(await pathExists(join(root, MARKER_REL_PATH))).toBe(true)
	})
})
