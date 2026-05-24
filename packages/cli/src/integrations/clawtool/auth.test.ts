import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { ClawtoolAuthError, readToken, tryReadToken } from './auth.js'

describe('readToken (strict)', () => {
	it('returns the trimmed token from a present file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-auth-'))
		const path = join(dir, 'token')
		writeFileSync(path, '  abc123\n')
		expect(readToken(path)).toBe('abc123')
	})

	it('throws ClawtoolAuthError when the file is missing', () => {
		expect(() => readToken('/no/such/path/token')).toThrow(ClawtoolAuthError)
	})

	it('throws ClawtoolAuthError when the file is empty', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-auth-'))
		const path = join(dir, 'empty-token')
		writeFileSync(path, '   \n  \n')
		expect(() => readToken(path)).toThrow(ClawtoolAuthError)
	})
})

describe('tryReadToken (lenient)', () => {
	it('returns the token when present', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-auth-'))
		const path = join(dir, 'token')
		writeFileSync(path, 'deadbeef\n')
		expect(tryReadToken(path)).toBe('deadbeef')
	})

	it('returns null for a missing file (no-auth daemon case)', () => {
		expect(tryReadToken('/no/such/path/token')).toBeNull()
	})

	it('returns null for an empty file', () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-auth-'))
		const path = join(dir, 'empty-token')
		writeFileSync(path, '')
		expect(tryReadToken(path)).toBeNull()
	})
})
