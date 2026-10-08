import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isTrusted, readTrustedDirs, trustDir, untrustDir } from './store.js'

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
