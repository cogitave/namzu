import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UNKNOWN_TENANT_ID } from '../../../types/ids/index.js'
import { FilesystemMigrationError } from '../errors.js'
import {
	DefaultFilesystemMigrator,
	type FilesystemMigrationEvent,
	type FilesystemMigrationSink,
	LEGACY_DEFAULT_PROJECT_PREFIX,
	LEGACY_DEFAULT_SESSION_ID,
	MARKER_REL_PATH,
	MIGRATION_VERSION,
} from '../filesystem.js'
import { acquireMigrationLock, writeMarker } from '../marker.js'

function collectingSink(): {
	events: FilesystemMigrationEvent[]
	sink: FilesystemMigrationSink
} {
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

describe('DefaultFilesystemMigrator.migrate', () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'namzu-fsmig-'))
	})

	afterEach(async () => {
		// chmod first in case a test left 000 perms on a directory.
		await chmod(root, 0o755).catch(() => undefined)
		await rm(root, { recursive: true, force: true })
	})

	it('cold boot with a single legacy thread: migrates, emits event, writes marker', async () => {
		await seedLegacyThread(root, 'thd_abc', ['run_xyz'])

		const { events, sink } = collectingSink()
		const migrator = new DefaultFilesystemMigrator(sink)

		const result = await migrator.migrate(root)

		expect(result.kind).toBe('migrated')
		expect(result.migratedThreads).toEqual([
			{ legacyThreadId: 'thd_abc', newProjectId: `${LEGACY_DEFAULT_PROJECT_PREFIX}abc` },
		])

		// New layout exists.
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
		expect(await pathExists(join(newRunDir, 'run.json'))).toBe(true)

		// Legacy path moved (runs/ sub-tree renamed).
		expect(await pathExists(join(root, 'threads', 'thd_abc', 'runs'))).toBe(false)

		// Marker landed.
		const markerRaw = await readFile(join(root, MARKER_REL_PATH), 'utf-8')
		const markerParsed = JSON.parse(markerRaw)
		expect(markerParsed.version).toBe(MIGRATION_VERSION)
		expect(markerParsed.migratedThreads).toHaveLength(1)

		// Event emitted with accurate result.
		expect(events).toHaveLength(1)
		expect(events[0]?.type).toBe('filesystem.migrated')
		expect(events[0]?.result.kind).toBe('migrated')
	})

	it('warm boot with an existing marker short-circuits to already_migrated', async () => {
		await writeMarker(join(root, MARKER_REL_PATH), {
			version: MIGRATION_VERSION,
			at: new Date(),
			migratedThreads: [],
		})
		await seedLegacyThread(root, 'thd_stillhere', ['run_ignored'])

		const { events, sink } = collectingSink()
		const migrator = new DefaultFilesystemMigrator(sink)

		const result = await migrator.migrate(root)

		expect(result.kind).toBe('already_migrated')
		expect(events).toHaveLength(0)
		// No migration happened — legacy path untouched.
		expect(await pathExists(join(root, 'threads', 'thd_stillhere', 'runs', 'run_ignored'))).toBe(
			true,
		)
	})

	it('cold boot with neither legacy nor marker writes a marker and returns noop_no_legacy', async () => {
		const { events, sink } = collectingSink()
		const migrator = new DefaultFilesystemMigrator(sink)

		const result = await migrator.migrate(root)

		expect(result.kind).toBe('noop_no_legacy')
		expect(events).toHaveLength(0)
		expect(await pathExists(join(root, MARKER_REL_PATH))).toBe(true)
	})

	it('cooperates with a concurrent migrator: main marker lands → already_migrated', async () => {
		await seedLegacyThread(root, 'thd_abc', ['run_1'])

		// Pre-seed the tmp lock to simulate another boot mid-migration.
		await acquireMigrationLock(join(root, '.migration', 'v0.2.0.tmp'))

		// Now write the main marker as the "winner" would. The loser must
		// see this on the re-check after waiting and return already_migrated.
		await writeMarker(join(root, MARKER_REL_PATH), {
			version: MIGRATION_VERSION,
			at: new Date(),
			migratedThreads: [
				{ legacyThreadId: 'thd_abc', newProjectId: `${LEGACY_DEFAULT_PROJECT_PREFIX}abc` },
			],
		})

		// Because readMarker is checked FIRST (before lock contention), this
		// actually returns already_migrated on step 1. That is the correct
		// semantics: the main marker is the single source of truth.
		const migrator = new DefaultFilesystemMigrator()
		const result = await migrator.migrate(root)
		expect(result.kind).toBe('already_migrated')
	})

	it('migrates multiple legacy threads in one pass with marker listing all', async () => {
		await seedLegacyThread(root, 'thd_a', ['run_a1', 'run_a2'])
		await seedLegacyThread(root, 'thd_b', ['run_b1'])
		await seedLegacyThread(root, 'thd_c', ['run_c1'])

		const migrator = new DefaultFilesystemMigrator()
		const result = await migrator.migrate(root)

		expect(result.kind).toBe('migrated')
		expect(result.migratedThreads).toHaveLength(3)
		const ids = result.migratedThreads.map((m) => m.legacyThreadId).sort()
		expect(ids).toEqual(['thd_a', 'thd_b', 'thd_c'])

		// Marker content mirrors result.
		const markerRaw = await readFile(join(root, MARKER_REL_PATH), 'utf-8')
		const markerParsed = JSON.parse(markerRaw)
		expect(markerParsed.migratedThreads).toHaveLength(3)
	})

	it('synthesized project.json has _legacy: true and tenantId: UNKNOWN_TENANT_ID', async () => {
		await seedLegacyThread(root, 'thd_tenantcheck', ['run_0'])
		const migrator = new DefaultFilesystemMigrator()
		await migrator.migrate(root)

		const projectJsonPath = join(
			root,
			'projects',
			`${LEGACY_DEFAULT_PROJECT_PREFIX}tenantcheck`,
			'project.json',
		)
		const parsed = JSON.parse(await readFile(projectJsonPath, 'utf-8'))
		expect(parsed._legacy).toBe(true)
		expect(parsed.tenantId).toBe(UNKNOWN_TENANT_ID)
		expect(parsed.id).toBe(`${LEGACY_DEFAULT_PROJECT_PREFIX}tenantcheck`)
		expect(parsed.config).toMatchObject({
			maxDelegationDepth: 4,
			maxDelegationWidth: 8,
			maxInterventionDepth: 10,
		})
	})

	it('synthesized session.json is idle and flagged _legacy', async () => {
		await seedLegacyThread(root, 'thd_sescheck', ['run_0'])
		const migrator = new DefaultFilesystemMigrator()
		await migrator.migrate(root)

		const sessionJsonPath = join(
			root,
			'projects',
			`${LEGACY_DEFAULT_PROJECT_PREFIX}sescheck`,
			'sessions',
			LEGACY_DEFAULT_SESSION_ID,
			'session.json',
		)
		const parsed = JSON.parse(await readFile(sessionJsonPath, 'utf-8'))
		expect(parsed.id).toBe(LEGACY_DEFAULT_SESSION_ID)
		expect(parsed.status).toBe('idle')
		expect(parsed.tenantId).toBe(UNKNOWN_TENANT_ID)
		expect(parsed._legacy).toBe(true)
	})

	it('idempotent: two successive migrate() calls produce the same end-state', async () => {
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

	it('error path: unwritable marker directory surfaces FilesystemMigrationError', async () => {
		// Make the rootDir read-only so write_marker fails on the noop branch
		// (simplest repro — no legacy threads needed).
		await chmod(root, 0o555)

		const migrator = new DefaultFilesystemMigrator()
		try {
			await migrator.migrate(root)
			expect.fail('expected migrate() to throw')
		} catch (err) {
			expect(err).toBeInstanceOf(FilesystemMigrationError)
			const details = (err as FilesystemMigrationError).details
			expect(details.op).toBe('write_marker')
			expect(details.path).toContain('v0.2.0')
		} finally {
			// restore perms so afterEach can clean up
			await chmod(root, 0o755).catch(() => undefined)
		}
	})
})
