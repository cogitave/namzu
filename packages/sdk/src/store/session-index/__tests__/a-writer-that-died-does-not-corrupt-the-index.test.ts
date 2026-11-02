import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ScanSessionIndex } from '../scan.js'
import { SqliteSessionIndex } from '../sqlite.js'
import { SLUG, dump, syntheticLog } from './support.js'

const here = dirname(fileURLToPath(import.meta.url))

let root: string
let home: string
let path: string

function addSessions(from: number, to: number): void {
	const project = join(home, 'projects', SLUG)
	mkdirSync(project, { recursive: true })
	for (let i = from; i < to; i++) {
		const { sessionId, text } = syntheticLog(`died-${i}`, 6)
		writeFileSync(join(project, `${sessionId}.jsonl`), text)
	}
}

function integrity(file: string): string {
	const db = new DatabaseSync(file, { readOnly: true })
	try {
		return (
			db.prepare('PRAGMA integrity_check').all() as {
				integrity_check: string
			}[]
		)
			.map((row) => row.integrity_check)
			.join('|')
	} finally {
		db.close()
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-session-index-died-'))
	home = join(root, 'home')
	path = join(home, 'index.sqlite')
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

/**
 * A Namzu process killed in the middle of an index write leaves a hot journal
 * beside `index.sqlite`. The next process must roll that journal back and carry
 * on with the same file. It used to read the file read-only, fail on the
 * journal, call the file "not a database", rename a rebuilt one over it and
 * leave the journal beside the new file, which the next connection then played
 * into it: "database disk image is malformed".
 */
describe('a writer that died inside a transaction', () => {
	it('leaves an index the next process rolls back and keeps using', async () => {
		addSessions(0, 10)
		;(await SqliteSessionIndex.open({ home, path })).close()

		// A real process, killed mid-transaction: its journal is hot.
		const worker = spawnSync(process.execPath, [join(here, 'killed-writer-worker.mjs'), path])
		expect(worker.signal).toBe('SIGKILL')
		expect(existsSync(`${path}-journal`)).toBe(true)

		// The logs moved on while nobody was looking, so a rebuilt file would differ
		// from the dead writer's pages.
		addSessions(10, 30)

		const first = await SqliteSessionIndex.open({ home, path })
		const second = await SqliteSessionIndex.open({ home, path })
		const scan = await ScanSessionIndex.load(home)
		try {
			expect(await dump(first)).toEqual(await dump(scan))
			expect(await dump(second)).toEqual(await dump(scan))
		} finally {
			first.close()
			second.close()
			scan.close()
		}
		expect(integrity(path)).toBe('ok')
		expect(existsSync(`${path}-journal`)).toBe(false)
	}, 120_000) // two real node processes and an index over 30 sessions
})
