/**
 * The cleanup helpers cannot fail a test.
 *
 * That is their whole reason to exist: a full-suite run went red on a test
 * whose assertion had passed, because `afterEach` could not delete a temp
 * directory and vitest attributes a hook failure to the test it ran after.
 *
 * These assertions are about the contract rather than about the filesystem,
 * because the filesystem race could not be reproduced — 15 isolated runs, 6
 * full-suite runs and an 80-round synthetic stress all passed. What is pinned
 * is that whatever the filesystem does, this does not throw.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir, removeTempDirAsync, removeTempDirs } from './temp-dir.js'

/** A path the platform refuses outright, whichever OS is running. */
const REFUSED = '\0invalid'

function plantTree(prefix: string): string {
	const root = mkdtempSync(join(tmpdir(), prefix))
	mkdirSync(join(root, 'a', 'b'), { recursive: true })
	writeFileSync(join(root, 'a', 'b', 'f.json'), '{}')
	return root
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('removeTempDir', () => {
	it('removes a tree', () => {
		const root = plantTree('namzu-rm-sync-')

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

	it('warns instead of throwing when removal fails, naming the path', () => {
		// The property that matters. A path the platform refuses outright stands
		// in for the transient lock that cannot be reproduced on demand — the
		// point is the catch, not which errno reaches it.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		expect(() => removeTempDir(REFUSED)).not.toThrow()

		expect(warn).toHaveBeenCalledTimes(1)
		const message = String(warn.mock.calls[0]?.[0] ?? '')
		// Names the path and says the test result stands, so a real handle leak is
		// still visible rather than silently swallowed.
		expect(message).toContain('could not remove')
		expect(message).toContain('unaffected')
	})
})

describe('removeTempDirAsync', () => {
	it('removes a tree', async () => {
		const root = plantTree('namzu-rm-async-')

		await removeTempDirAsync(root)

		expect(existsSync(root)).toBe(false)
	})

	it('warns instead of rejecting when removal fails', async () => {
		// A rejected teardown promise fails the hook exactly as a thrown error
		// does, so the async form needs this property proven separately rather
		// than inherited from the sync one.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

		await expect(removeTempDirAsync(REFUSED)).resolves.toBeUndefined()

		expect(warn).toHaveBeenCalledTimes(1)
		expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('could not remove')
	})
})

describe('removeTempDirs', () => {
	it('removes every tree it is given', async () => {
		const roots = [plantTree('namzu-rm-many-a-'), plantTree('namzu-rm-many-b-')]

		await removeTempDirs(roots)

		expect(roots.map((r) => existsSync(r))).toEqual([false, false])
	})

	it('removes the rest when one path is refused', async () => {
		// `Promise.all` abandons its siblings' results on the first rejection, so
		// a bare `rm` in the middle of a list left the remaining directories
		// undeleted AND failed the hook. Each removal owning its own catch is
		// what makes the list independent.
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const roots = [plantTree('namzu-rm-mixed-a-'), plantTree('namzu-rm-mixed-b-')]

		await removeTempDirs([roots[0] as string, REFUSED, roots[1] as string])

		expect(roots.map((r) => existsSync(r))).toEqual([false, false])
		expect(warn).toHaveBeenCalledTimes(1)
	})
})
