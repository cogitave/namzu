/**
 * The cleanup helper cannot fail a test.
 *
 * That is its whole reason to exist: a full-suite run went red on a test whose
 * assertion had passed, because `afterEach` could not delete a temp directory
 * and vitest attributes a hook failure to the test it ran after.
 *
 * These assertions are about the helper's contract rather than about the
 * filesystem, because the filesystem race could not be reproduced — 15 isolated
 * runs, 6 full-suite runs and an 80-round synthetic stress all passed. What is
 * pinned is that whatever the filesystem does, this does not throw.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from './temp-dir.js'

afterEach(() => {
	vi.restoreAllMocks()
})

describe('removeTempDir', () => {
	it('removes a tree', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-rm-'))
		mkdirSync(join(root, 'a', 'b'), { recursive: true })
		writeFileSync(join(root, 'a', 'b', 'f.json'), '{}')

		removeTempDir(root)

		expect(existsSync(root)).toBe(false)
	})

	it('is silent on a path that is already gone', () => {
		// `force: true` covers this, and a warning here would be noise on every
		// suite that cleans up twice.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		removeTempDir(join(tmpdir(), 'namzu-rm-does-not-exist-xyzzy'))
		expect(warn).not.toHaveBeenCalled()
	})

	it('warns instead of throwing when removal fails', () => {
		// The property that matters. A path the platform refuses outright stands
		// in for the transient lock that cannot be reproduced on demand — the
		// point is the catch, not which errno reaches it.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		expect(() => removeTempDir('\0invalid')).not.toThrow()
		expect(warn).toHaveBeenCalledTimes(1)
		const message = String(warn.mock.calls[0]?.[0] ?? '')
		// Names the path and says the test result stands, so a real handle leak
		// is still visible rather than silently swallowed.
		expect(message).toContain('could not remove')
		expect(message).toContain('unaffected')
	})
})
