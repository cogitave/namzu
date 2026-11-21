import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { canonicalProjectPath } from '../../permissions/canonical-project.js'
import { StateFileUnreadableError } from '../state/state-file.js'
import {
	assertTrustListWritable,
	isTrusted,
	readTrustedDirs,
	trustDir,
	trustListProblem,
	untrustDir,
} from './store.js'

let home: string
let work: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-trust-'))
	work = mkdtempSync(join(tmpdir(), 'namzu-proj-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(work)
})

describe('trust store', () => {
	it('starts empty and untrusted', () => {
		expect(readTrustedDirs(home)).toEqual([])
		expect(isTrusted(work, home)).toBe(false)
	})

	it('trusts a directory and persists it', () => {
		trustDir(work, home)
		expect(isTrusted(work, home)).toBe(true)
		expect(readTrustedDirs(home).length).toBe(1)
	})

	it('is idempotent', () => {
		trustDir(work, home)
		trustDir(work, home)
		expect(readTrustedDirs(home).length).toBe(1)
	})

	it('trusting a folder covers its subfolders (ancestor match)', () => {
		const sub = join(work, 'packages', 'cli')
		mkdirSync(sub, { recursive: true })
		trustDir(work, home)
		expect(isTrusted(sub, home)).toBe(true)
	})

	it('does not trust an unrelated sibling', () => {
		const other = mkdtempSync(join(tmpdir(), 'namzu-other-'))
		trustDir(work, home)
		expect(isTrusted(other, home)).toBe(false)
		removeTempDir(other)
	})

	it('does not treat a path-prefix sibling as trusted', () => {
		// /tmp/proj must not match /tmp/proj-2 just by string prefix.
		trustDir(work, home)
		expect(isTrusted(`${work}-2`, home)).toBe(false)
	})
})

describe('untrustDir', () => {
	it('removes only the exact folder and leaves other entries', () => {
		const other = mkdtempSync(join(tmpdir(), 'namzu-other-'))
		trustDir(work, home)
		trustDir(other, home)
		expect(untrustDir(work, home)).toEqual({ removed: true })
		expect(isTrusted(work, home)).toBe(false)
		expect(isTrusted(other, home)).toBe(true)
		removeTempDir(other)
	})

	it('is idempotent and reports nothing removed the second time', () => {
		trustDir(work, home)
		untrustDir(work, home)
		expect(untrustDir(work, home)).toEqual({ removed: false })
		expect(readTrustedDirs(home)).toEqual([])
	})

	it('does not touch an ancestor entry and reports that it still covers the folder', () => {
		const sub = join(work, 'packages', 'cli')
		mkdirSync(sub, { recursive: true })
		trustDir(work, home)
		trustDir(sub, home)
		const result = untrustDir(sub, home)
		expect(result.removed).toBe(true)
		expect(result.stillTrustedBy).toBeDefined()
		expect(isTrusted(sub, home)).toBe(true)
		expect(readTrustedDirs(home).length).toBe(1)
	})

	it('reports an ancestor cover even when the folder itself had no entry', () => {
		const sub = join(work, 'a')
		mkdirSync(sub, { recursive: true })
		trustDir(work, home)
		const result = untrustDir(sub, home)
		expect(result.removed).toBe(false)
		expect(result.stillTrustedBy).toBeDefined()
	})
})

describe('a trusted folders list that cannot be read', () => {
	const file = () => join(home, '.namzu', 'trust.json')
	const backups = () => join(home, '.namzu', 'backups')

	it.each([
		['not JSON', '{"version":1,"trusted":["/a"', 'not valid JSON'],
		['not an object', '["/a"]', 'not a trust list'],
		[
			'a list that is not a list',
			'{"version":1,"trusted":"/a"}',
			'its "trusted" entry is not a list',
		],
		['a newer version', '{"version":2,"trusted":[]}', 'version 2 is newer than this Namzu'],
	])('(%s) trusts nothing, is kept, and is never replaced', (_, text, reason) => {
		writeFileSync(file(), text)
		expect(isTrusted(work, home)).toBe(false)
		expect(trustListProblem(home)).toEqual({ file: file(), reason })
		let error: unknown
		try {
			trustDir(work, home)
		} catch (caught) {
			error = caught
		}
		expect(error).toBeInstanceOf(StateFileUnreadableError)
		expect(readFileSync(file(), 'utf8')).toBe(text)
		const kept = readdirSync(backups()).filter((name) => name.startsWith('trust.json.corrupt-'))
		expect(kept).toHaveLength(1)
		expect(readFileSync(join(backups(), kept[0] as string), 'utf8')).toBe(text)
		// Removing is refused too, rather than answered "it was not on the list".
		expect(() => untrustDir(work, home)).toThrow(StateFileUnreadableError)
		expect(() => assertTrustListWritable(home)).toThrow(StateFileUnreadableError)
		// The same damage is kept once, however often it is met.
		expect(readdirSync(backups()).filter((name) => name.includes('.corrupt-'))).toHaveLength(1)
	})

	it('names the last good copy so it can be put back by hand', () => {
		const other = mkdtempSync(join(tmpdir(), 'namzu-other-'))
		trustDir(work, home)
		trustDir(other, home)
		writeFileSync(file(), '{ damaged')
		let error: StateFileUnreadableError | undefined
		try {
			trustDir(work, home)
		} catch (caught) {
			error = caught as StateFileUnreadableError
		}
		expect(error?.backup).toBeDefined()
		expect(JSON.parse(readFileSync(error?.backup as string, 'utf8')).trusted).toEqual([
			canonicalProjectPath(work),
		])
		expect(error?.message).toContain('to go back to it, copy it over')
		removeTempDir(other)
	})

	it('keeps entries and keys it does not understand when it changes the list', () => {
		writeFileSync(file(), JSON.stringify({ version: 1, trusted: [7, '/gone'], note: 'kept' }))
		trustDir(work, home)
		const stored = JSON.parse(readFileSync(file(), 'utf8'))
		expect(stored).toEqual({
			version: 1,
			trusted: [7, '/gone', canonicalProjectPath(work)],
			note: 'kept',
		})
		untrustDir(work, home)
		expect(JSON.parse(readFileSync(file(), 'utf8'))).toEqual({
			version: 1,
			trusted: [7, '/gone'],
			note: 'kept',
		})
	})

	it('reads a missing list as empty and a missing entry as an empty list', () => {
		expect(trustListProblem(home)).toBeUndefined()
		writeFileSync(file(), '{"version":1}')
		expect(trustListProblem(home)).toBeUndefined()
		trustDir(work, home)
		expect(isTrusted(work, home)).toBe(true)
	})

	it('writes the list private and keeps a private copy of the old one', () => {
		trustDir(work, home)
		const other = mkdtempSync(join(tmpdir(), 'namzu-other-'))
		trustDir(other, home)
		const copies = readdirSync(backups()).filter((name) => name.startsWith('trust.json.backup.'))
		expect(copies).toHaveLength(1)
		if (process.platform !== 'win32') {
			expect(statSync(file()).mode & 0o777).toBe(0o600)
			expect(statSync(join(backups(), copies[0] as string)).mode & 0o777).toBe(0o600)
		}
		removeTempDir(other)
	})
})
