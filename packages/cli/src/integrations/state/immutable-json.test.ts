import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { publishPrivateJsonIfAbsent } from './immutable-json.js'

vi.mock('node:fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs')>()
	return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) }
})

let home: string

afterEach(() => {
	vi.restoreAllMocks()
	removeTempDir(home)
})

describe('immutable JSON publication', () => {
	it('does not expose an unfinished record if preparing it fails', () => {
		home = fs.mkdtempSync(join(tmpdir(), 'namzu-immutable-json-'))
		const path = join(home, 'identity.json')
		vi.mocked(fs.fsyncSync).mockImplementationOnce(() => {
			throw new Error('disk sync failed')
		})

		expect(() => publishPrivateJsonIfAbsent(path, { id: 'candidate' })).toThrow('disk sync failed')
		expect(fs.existsSync(path)).toBe(false)
		expect(fs.readdirSync(home)).toEqual([])
	})

	it('never replaces an existing record, including an invalid one', () => {
		home = fs.mkdtempSync(join(tmpdir(), 'namzu-immutable-json-'))
		const path = join(home, 'identity.json')
		fs.writeFileSync(path, '{invalid')

		publishPrivateJsonIfAbsent(path, { id: 'candidate' })

		expect(fs.readFileSync(path, 'utf8')).toBe('{invalid')
		expect(fs.readdirSync(home)).toEqual(['identity.json'])
	})
})
