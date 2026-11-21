import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SqliteSessionIndex } from '../sqlite.js'
import { homeWithFixtures } from './support.js'

// The index holds prompt openings and the full text of tool results and
// replies: other users of the machine must not be able to read it.
const posix = process.platform !== 'win32'

let root: string
let home: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-index-mode-'))
	home = join(root, 'home')
	homeWithFixtures(home)
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

const modeOf = (path: string): number => statSync(path).mode & 0o777

describe.runIf(posix)('the session index file mode', () => {
	it('builds a new index owner-only, in an owner-only folder it creates', async () => {
		const path = join(root, 'fresh-home', 'index.sqlite')
		const index = await SqliteSessionIndex.open({ home, path })
		try {
			expect(modeOf(path)).toBe(0o600)
			expect(modeOf(join(root, 'fresh-home'))).toBe(0o700)
			expect((await index.listSessions({})).length).toBeGreaterThan(0)
		} finally {
			index.close()
		}
	})

	it('narrows an index an earlier version left readable, and its journal files, on open', async () => {
		const path = join(home, 'index.sqlite')
		const first = await SqliteSessionIndex.open({ home, path })
		first.close()
		chmodSync(path, 0o644)
		for (const suffix of ['-wal', '-shm']) {
			writeFileSync(`${path}${suffix}`, '')
			chmodSync(`${path}${suffix}`, 0o644)
		}

		const index = await SqliteSessionIndex.open({ home, path })
		try {
			expect(modeOf(path)).toBe(0o600)
			expect(modeOf(`${path}-wal`)).toBe(0o600)
			expect(modeOf(`${path}-shm`)).toBe(0o600)
			// Nothing was rebuilt or lost on the way.
			expect((await index.listSessions({})).length).toBeGreaterThan(0)
		} finally {
			index.close()
		}
	})

	it('rebuilds a forced index owner-only', async () => {
		const path = join(home, 'index.sqlite')
		const first = await SqliteSessionIndex.open({ home, path })
		first.close()
		chmodSync(path, 0o644)
		await SqliteSessionIndex.rebuild({ home, path, force: true })
		expect(modeOf(path)).toBe(0o600)
	})

	it('leaves an existing folder with the mode it has', async () => {
		chmodSync(home, 0o750)
		const index = await SqliteSessionIndex.open({ home, path: join(home, 'index.sqlite') })
		index.close()
		expect(modeOf(home)).toBe(0o750)
	})
})
