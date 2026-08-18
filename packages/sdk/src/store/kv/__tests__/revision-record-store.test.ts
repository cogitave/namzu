import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defineSchema } from '../../schema.js'
import { DiskRecordStore } from '../record-store.js'
import {
	DiskRevisionRecordStore,
	type RevisionedRecordLocation,
	decodeRevisionFileSegment,
	legacyRevisionFileSegment,
	revisionFileSegment,
} from '../revision-record-store.js'

interface RecordValue {
	readonly revision: number
	readonly value: string
}

const SCHEMA = defineSchema({
	kind: 'revision-record-test',
	current: 1,
	migrations: {},
})
const roots: string[] = []

afterEach(async () => {
	for (const root of roots) await rm(root, { recursive: true, force: true })
	roots.length = 0
})

async function fixture(): Promise<{
	root: string
	location: RevisionedRecordLocation
	store: DiskRevisionRecordStore<RecordValue>
}> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-revision-record-'))
	roots.push(root)
	return {
		root,
		location: {
			legacyPath: join(root, 'record.json'),
			revisionsDir: join(root, '.revisions', 'record'),
		},
		store: new DiskRevisionRecordStore<RecordValue>(
			SCHEMA,
			'test revision store',
			(record) => record.revision,
		),
	}
}

describe('an immutable revision record', () => {
	it('publishes exactly one winner for a simultaneous revision', async () => {
		const { location, store } = await fixture()
		const write = (value: string) =>
			store.transact(location, (current) => {
				const actual = current?.revision ?? 0
				if (actual !== 0) throw new Error(`stale at ${actual}`)
				const record = { revision: 1, value }
				return { record, result: record }
			})

		const results = await Promise.allSettled([write('a'), write('b')])

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
		const durable = await store.read(location)
		const winner = (
			results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<RecordValue>
		).value
		expect(durable).toMatchObject(winner)
	})

	it('reads a legacy record and advances it into a complete schema-stamped commit', async () => {
		const { location, store } = await fixture()
		await writeFile(location.legacyPath, JSON.stringify({ revision: 4, value: 'legacy' }), 'utf-8')

		const written = await store.transact(location, (current) => {
			expect(current).toMatchObject({ revision: 4, value: 'legacy' })
			const record = { revision: 5, value: 'current' }
			return { record, result: record }
		})

		expect(written).toEqual({ revision: 5, value: 'current' })
		const bytes = JSON.parse(
			await readFile(join(location.revisionsDir, '5.json'), 'utf-8'),
		) as RecordValue & { schemaVersion: number }
		expect(bytes).toEqual({ revision: 5, value: 'current', schemaVersion: 1 })
	})

	it('refuses a revision filename whose complete body claims another revision', async () => {
		const { location, store } = await fixture()
		await mkdir(location.revisionsDir, { recursive: true })
		await writeFile(
			join(location.revisionsDir, '7.json'),
			JSON.stringify({ revision: 6, value: 'misnamed' }),
			'utf-8',
		)

		await expect(store.read(location)).rejects.toThrow(/filename and record body disagree/)
	})

	it('refuses a legacy writer that advances beyond the immutable head', async () => {
		const { location, store } = await fixture()
		await store.transact(location, () => {
			const record = { revision: 1, value: 'committed' }
			return { record, result: record }
		})
		await writeFile(
			location.legacyPath,
			JSON.stringify({ revision: 2, value: 'old binary advanced' }),
			'utf-8',
		)

		await expect(store.read(location)).rejects.toThrow(/legacy projection is ahead/)
	})

	it('retries when a current writer advances between the head listing and projection read', async () => {
		const { location, store } = await fixture()
		for (const value of ['first', 'second']) {
			await store.transact(location, (current) => {
				const record = { revision: (current?.revision ?? 0) + 1, value }
				return { record, result: record }
			})
		}

		const originalScan = DiskRecordStore.prototype.scanNames
		let revisionScans = 0
		const scan = vi
			.spyOn(DiskRecordStore.prototype, 'scanNames')
			.mockImplementation(async function (this: DiskRecordStore<unknown>, dir, prefix) {
				const names = await originalScan.call(this, dir, prefix)
				if (dir === location.revisionsDir && revisionScans++ === 0) {
					// The first directory snapshot happened before revision 2 was
					// linked; the projection read that follows happened after it.
					return names.filter((name) => name !== '2.json')
				}
				return names
			})

		try {
			expect(await store.read(location)).toMatchObject({
				revision: 2,
				value: 'second',
			})
		} finally {
			scan.mockRestore()
		}
	})

	it('never treats scratch debris as a committed revision', async () => {
		const { location, store } = await fixture()
		await mkdir(location.revisionsDir, { recursive: true })
		await writeFile(join(location.revisionsDir, '9.json.1.1.deadbeef.tmp'), '{"revision":', 'utf-8')

		expect(await store.read(location)).toBeNull()
	})
})

describe('revision filesystem segments', () => {
	it('is injective for path syntax, escape-looking text and invalid Unicode', () => {
		const inputs = ['../x', '..~002fx', 'a/b', 'a\\b', '', '~empty', '\ud800', '.', '%2F']
		const encoded = inputs.map(revisionFileSegment)

		expect(new Set(encoded).size).toBe(inputs.length)
		for (const segment of encoded) {
			expect(segment).not.toMatch(/[\\/.]/)
			expect(segment).not.toBe('..')
		}
	})

	it('round-trips every canonical segment without admitting aliases', () => {
		const inputs = ['msg_plain', '../x', 'a\\b', '', '~empty', '\ud800', 'ü', '%2F']
		for (const input of inputs) {
			expect(decodeRevisionFileSegment(revisionFileSegment(input))).toBe(input)
		}
		expect(decodeRevisionFileSegment('')).toBeNull()
		expect(decodeRevisionFileSegment('~0061')).toBeNull()
		expect(decodeRevisionFileSegment('~00AF')).toBeNull()
		expect(decodeRevisionFileSegment('not.valid')).toBeNull()
	})

	it('preserves an old single-component projection name but confines separators', () => {
		expect(legacyRevisionFileSegment('objective.v1 ü')).toBe('objective.v1 ü')
		expect(legacyRevisionFileSegment('../objective')).toBe(revisionFileSegment('../objective'))
		expect(legacyRevisionFileSegment('a\\b')).toBe(revisionFileSegment('a\\b'))
	})
})
