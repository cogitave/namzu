import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScanSessionIndex } from '../scan.js'
import { SqliteSessionIndex, rebuildSqliteSessionIndex } from '../sqlite.js'
import { SLUG, dump, syntheticLog } from './support.js'

const here = dirname(fileURLToPath(import.meta.url))
// Built output, not source: a separate node process with no loader.
const dist = join(here, '..', '..', '..', '..', 'dist')

let root: string
let home: string
let path: string

function addSessions(from: number, to: number): void {
	const project = join(home, 'projects', SLUG)
	mkdirSync(project, { recursive: true })
	for (let i = from; i < to; i++) {
		const { sessionId, text } = syntheticLog(`moved-${i}`, 4)
		writeFileSync(join(project, `${sessionId}.jsonl`), text)
	}
}

function integrity(file: string): string {
	const db = new DatabaseSync(file, { readOnly: true })
	try {
		return (db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[])
			.map((row) => row.integrity_check)
			.join('|')
	} finally {
		db.close()
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-session-index-moved-'))
	home = join(root, 'home')
	path = join(home, 'index.sqlite')
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

describe('an index file replaced under an open session', () => {
	it('is reopened by the session, which then reads and writes the new file', async () => {
		expect(existsSync(join(dist, 'store', 'session-index', 'index.js'))).toBe(true)
		addSessions(0, 5)
		const session = await SqliteSessionIndex.open({ home, path })
		try {
			// Another process rebuilds the index and renames a new file over it.
			addSessions(5, 9)
			const worker = spawnSync(
				process.execPath,
				[join(here, 'forced-rebuild-worker.mjs'), dist, home, path],
				{
					encoding: 'utf8',
				},
			)
			expect(worker.status).toBe(0)
			expect(JSON.parse(worker.stdout.trim())).toEqual({ replaced: true })

			// Used to fail with "attempt to write a readonly database" (and read stale rows).
			await session.sync(home)
			addSessions(9, 12)
			await session.sync(home)

			const scan = await ScanSessionIndex.load(home)
			try {
				expect(await dump(session)).toEqual(await dump(scan))
			} finally {
				scan.close()
			}
		} finally {
			session.close()
		}
		expect(integrity(path)).toBe('ok')
	}, 120_000) // a real node process and an index over a dozen sessions

	it('answers reads from the new file without a write in between', async () => {
		addSessions(0, 3)
		const session = await SqliteSessionIndex.open({ home, path })
		try {
			addSessions(3, 6)
			await rebuildSqliteSessionIndex({ home, path, force: true })
			expect((await session.listSessions()).length).toBe(6)
		} finally {
			session.close()
		}
	})
})

describe('a rebuild over a file that is not a database', () => {
	it('leaves no stale journal behind to be played into the new index', async () => {
		addSessions(0, 4)
		mkdirSync(home, { recursive: true })
		writeFileSync(path, 'this is not a database'.repeat(200))
		writeFileSync(`${path}-journal`, Buffer.alloc(2048, 7))
		const session = await SqliteSessionIndex.open({ home, path })
		session.close()
		expect(existsSync(`${path}-journal`)).toBe(false)
		expect(integrity(path)).toBe('ok')
	})

	it('does not replace a current index unless forced', async () => {
		addSessions(0, 2)
		;(await SqliteSessionIndex.open({ home, path })).close()
		expect(await rebuildSqliteSessionIndex({ home, path })).toBe(false)
		expect(await rebuildSqliteSessionIndex({ home, path, force: true })).toBe(true)
	})
})
