import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { homeWithFixtures } from './support.js'

let root: string
let home: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-session-index-'))
	home = join(root, 'home')
	homeWithFixtures(home)
})

afterEach(() => {
	vi.doUnmock('node:module')
	vi.resetModules()
	rmSync(root, { recursive: true, force: true })
})

/**
 * Node 20 has no `node:sqlite` (and Node 22 before 22.13 hides it behind a
 * flag). Loading it fails there, and the index must fall back to scanning the
 * logs rather than fail. Simulated by making the module loader refuse it.
 */
describe('where node:sqlite does not load', () => {
	it('opens the scan index, and SqliteSessionIndex refuses with a named error', async () => {
		vi.resetModules()
		vi.doMock('node:module', async (importOriginal) => {
			const original = await importOriginal<typeof import('node:module')>()
			return {
				...original,
				createRequire: (from: string | URL) => {
					const require = original.createRequire(from)
					return Object.assign((id: string) => {
						if (id === 'node:sqlite') throw new Error('No such built-in module: node:sqlite')
						return require(id)
					}, require)
				},
			}
		})
		const { openSessionIndex, sqliteAvailable, SqliteSessionIndex, SessionIndexError } =
			await import('../index.js')

		expect(sqliteAvailable()).toBe(false)
		const index = await openSessionIndex({ home })
		try {
			expect(index.backend).toBe('scan')
			expect((await index.listSessions()).length).toBeGreaterThanOrEqual(12)
		} finally {
			index.close()
		}
		expect(existsSync(join(home, 'index.sqlite'))).toBe(false)
		await expect(
			SqliteSessionIndex.open({ home, path: join(home, 'index.sqlite') }),
		).rejects.toBeInstanceOf(SessionIndexError)
	})
})
