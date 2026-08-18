import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let linkFails: NodeJS.ErrnoException | null = null
let writeFileFails: NodeJS.ErrnoException | null = null

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>()
	return {
		...actual,
		link: async (...args: Parameters<typeof actual.link>) => {
			if (linkFails) throw linkFails
			return await actual.link(...args)
		},
		writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
			if (writeFileFails) throw writeFileFails
			return await actual.writeFile(...args)
		},
	}
})

const { defineSchema } = await import('../../schema.js')
const { DiskRevisionRecordStore } = await import('../revision-record-store.js')

function errno(code: string): NodeJS.ErrnoException {
	const error: NodeJS.ErrnoException = new Error(`mock ${code}`)
	error.code = code
	return error
}

describe('a filesystem that cannot publish an immutable revision', () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), 'namzu-revision-fs-'))
		linkFails = null
		writeFileFails = null
	})

	afterEach(async () => {
		linkFails = null
		writeFileFails = null
		await rm(root, { recursive: true, force: true })
	})

	function write() {
		const schema = defineSchema({
			kind: 'revision-fs-test',
			current: 1,
			migrations: {},
		})
		const store = new DiskRevisionRecordStore<{
			revision: number
			value: string
		}>(schema, 'test revision store', (record) => record.revision)
		return store.transact(
			{
				legacyPath: join(root, 'record.json'),
				revisionsDir: join(root, '.revisions', 'record'),
			},
			() => {
				const record = { revision: 1, value: 'x' }
				return { record, result: record }
			},
		)
	}

	it.each(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK'])(
		'refuses instead of falling back when link answers %s',
		async (code) => {
			linkFails = errno(code)

			await expect(write()).rejects.toThrow(
				new RegExp(`${code}[\\s\\S]*hard-link support[\\s\\S]*refusing`),
			)
		},
	)

	it('does not classify a full disk as a missing hard-link capability', async () => {
		linkFails = errno('ENOSPC')

		await expect(write()).rejects.toThrow(/mock ENOSPC/)
	})

	it('does not let a scratch collision masquerade as an ordinary lost CAS race', async () => {
		writeFileFails = errno('EEXIST')

		await expect(write()).rejects.toThrow(/temporary publication path already exists/)
	})
})
