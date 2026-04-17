import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectId } from '../../../types/session/ids.js'
import { acquireMigrationLock, readMarker, releaseMigrationLock, writeMarker } from '../marker.js'

describe('migration marker I/O', () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'namzu-marker-'))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it('readMarker returns null when the file is missing', async () => {
		const result = await readMarker(join(root, 'missing.json'))
		expect(result).toBeNull()
	})

	it('readMarker parses a valid JSON marker', async () => {
		const path = join(root, 'v0.2.0')
		const at = new Date('2026-04-17T00:00:00.000Z')
		await writeMarker(path, {
			version: '0.2.0',
			at,
			migratedThreads: [{ legacyThreadId: 'thd_abc', newProjectId: 'prj_legacy_abc' as ProjectId }],
		})
		const result = await readMarker(path)
		expect(result).not.toBeNull()
		expect(result?.version).toBe('0.2.0')
		expect(result?.at.toISOString()).toBe('2026-04-17T00:00:00.000Z')
		expect(result?.migratedThreads).toEqual([
			{ legacyThreadId: 'thd_abc', newProjectId: 'prj_legacy_abc' },
		])
	})

	it('readMarker returns null on corrupt JSON (retry-safe)', async () => {
		const path = join(root, 'corrupt.json')
		await writeFile(path, '{ not valid json', 'utf-8')
		const result = await readMarker(path)
		expect(result).toBeNull()
	})

	it('writeMarker atomically writes via tmp-rename (no partial content)', async () => {
		const path = join(root, 'v0.2.0')
		await writeMarker(path, {
			version: '0.2.0',
			at: new Date(),
			migratedThreads: [],
		})
		const content = await readFile(path, 'utf-8')
		const parsed = JSON.parse(content)
		expect(parsed.version).toBe('0.2.0')
	})

	it('acquireMigrationLock succeeds on first call and throws EEXIST on the second', async () => {
		const lockPath = join(root, 'v0.2.0.tmp')
		await acquireMigrationLock(lockPath)
		let caught: NodeJS.ErrnoException | null = null
		try {
			await acquireMigrationLock(lockPath)
		} catch (err) {
			caught = err as NodeJS.ErrnoException
		}
		expect(caught).not.toBeNull()
		expect(caught?.code).toBe('EEXIST')
	})

	it('releaseMigrationLock tolerates a missing file (idempotent)', async () => {
		const lockPath = join(root, 'never-existed.tmp')
		await expect(releaseMigrationLock(lockPath)).resolves.toBeUndefined()
	})

	it('releaseMigrationLock clears the lock so re-acquire succeeds', async () => {
		const lockPath = join(root, 'v0.2.0.tmp')
		await acquireMigrationLock(lockPath)
		await releaseMigrationLock(lockPath)
		await expect(acquireMigrationLock(lockPath)).resolves.toBeUndefined()
	})
})
