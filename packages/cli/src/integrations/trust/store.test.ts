import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isTrusted, readTrustedDirs, trustDir } from './store.js'

let home: string
let work: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-trust-'))
	work = mkdtempSync(join(tmpdir(), 'namzu-proj-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
})
afterEach(() => {
	rmSync(home, { recursive: true, force: true })
	rmSync(work, { recursive: true, force: true })
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
		rmSync(other, { recursive: true, force: true })
	})

	it('does not treat a path-prefix sibling as trusted', () => {
		// /tmp/proj must not match /tmp/proj-2 just by string prefix.
		trustDir(work, home)
		expect(isTrusted(`${work}-2`, home)).toBe(false)
	})
})
