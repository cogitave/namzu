import { spawnSync } from 'node:child_process'
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ids } from '../../../__fixtures__/session-log/build.js'
import type { SessionId } from '../../../types/ids/index.js'
import { SESSION_RECORD_MAX_BYTES } from '../../../types/session/records.js'
import { SESSION_INDEX_VERSION, type SessionIndex, openSessionIndex } from '../index.js'
import { discoverSessionLogs } from '../rebuild.js'
import { ScanSessionIndex } from '../scan.js'
import { SqliteSessionIndex, rebuildSqliteSessionIndex } from '../sqlite.js'
import { SLUG, dump, homeWithFixtures, syntheticLog } from './support.js'

let root: string
let home: string
let path: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-session-index-'))
	home = join(root, 'home')
	path = join(home, 'index.sqlite')
	homeWithFixtures(home)
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

const sid = (name: string) => ids.session(name) as SessionId

function logOf(name: string) {
	return {
		slug: SLUG,
		logPath: join(home, 'projects', SLUG, `${sid(name)}.jsonl`),
		sessionId: sid(name),
	}
}

describe.each([
	{ name: 'sqlite', open: () => SqliteSessionIndex.open({ home, path }) },
	{ name: 'scan', open: () => ScanSessionIndex.load(home) },
] as { name: string; open(): Promise<SessionIndex> }[])('$name: staleness', (backend) => {
	it('reads a log that has not changed as fresh', async () => {
		const index = await backend.open()
		try {
			expect(await index.staleness(logOf('valid'))).toBe('fresh')
		} finally {
			index.close()
		}
	})

	it('detects a truncated log and re-derives the session', async () => {
		const index = await backend.open()
		try {
			const log = logOf('valid')
			const lines = readFileSync(log.logPath, 'utf8').split(/(?<=\n)/)
			writeFileSync(log.logPath, lines.slice(0, 5).join(''))
			expect(await index.staleness(log)).toBe('truncated')
			expect(await index.refresh(log)).toBe('truncated')
			expect((await index.getSession(log.sessionId))?.headSeq).toBe(5)
			expect((await index.listTurns(log.sessionId)).map((t) => t.status)).toEqual(['running'])
			expect(await index.staleness(log)).toBe('fresh')
		} finally {
			index.close()
		}
	})

	it('detects an edited head record of the same length and re-derives the session', async () => {
		const index = await backend.open()
		try {
			const log = logOf('valid')
			const text = readFileSync(log.logPath, 'utf8')
			// Same byte count, different bytes, in the last record: the chain
			// still reads (nothing points at the head), so only the hash shows it.
			const edited = text.replace('"result":"You are welcome."', '"result":"You are WELCOME."')
			expect(edited).not.toBe(text)
			expect(Buffer.byteLength(edited)).toBe(Buffer.byteLength(text))
			writeFileSync(log.logPath, edited)
			expect(await index.staleness(log)).toBe('rewritten')
			expect(await index.refresh(log)).toBe('rewritten')
			expect(await index.staleness(log)).toBe('fresh')
		} finally {
			index.close()
		}
	})

	it('detects a log truncated inside its head record', async () => {
		const index = await backend.open()
		try {
			const log = logOf('valid')
			const size = readFileSync(log.logPath).byteLength
			truncateSync(log.logPath, size - 10)
			expect(await index.staleness(log)).toBe('truncated')
			await index.refresh(log)
			// The last record is torn now, so the intact prefix ends one record earlier.
			expect((await index.getSession(log.sessionId))?.headSeq).toBe(23)
		} finally {
			index.close()
		}
	})

	it('continues a grown log from its head', async () => {
		const index = await backend.open()
		try {
			const log = logOf('valid')
			const before = await index.getSession(log.sessionId)
			const lines = readFileSync(log.logPath, 'utf8').split(/(?<=\n)/)
			writeFileSync(log.logPath, lines.slice(0, 10).join(''))
			await index.refresh(log)
			appendFileSync(log.logPath, lines.slice(10).join(''))
			expect(await index.staleness(log)).toBe('grown')
			expect(await index.refresh(log)).toBe('grown')
			expect(await index.getSession(log.sessionId)).toEqual(before)
		} finally {
			index.close()
		}
	})

	it('reports a missing log, and drops its session on refresh or sync', async () => {
		const index = await backend.open()
		try {
			const valid = logOf('valid')
			const guardrail = logOf('guardrail')
			unlinkSync(valid.logPath)
			unlinkSync(guardrail.logPath)
			expect(await index.staleness(valid)).toBe('missing')
			expect(await index.refresh(valid)).toBe('missing')
			expect(await index.getSession(valid.sessionId)).toBeUndefined()
			expect(await index.getSession(guardrail.sessionId)).toBeDefined()
			await index.sync(home)
			expect(await index.getSession(guardrail.sessionId)).toBeUndefined()
			expect(await index.listTurns(guardrail.sessionId)).toEqual([])
		} finally {
			index.close()
		}
	})

	it('reads a log whose head record is as long as a record may be as fresh', async () => {
		// Through the answer of one turn; the answer is padded to the maximum line length.
		const build = (pad: number) => {
			const { sessionId, text } = syntheticLog('max-record', 1, () => 'x'.repeat(pad))
			return { sessionId, lines: text.split(/(?<=\n)/).slice(0, 4) }
		}
		const overhead = Buffer.byteLength(build(10).lines[3] as string) - 10
		const { sessionId, lines } = build(SESSION_RECORD_MAX_BYTES - overhead)
		expect(Buffer.byteLength(lines[3] as string)).toBe(SESSION_RECORD_MAX_BYTES)
		const logPath = join(home, 'projects', SLUG, `${sessionId}.jsonl`)
		writeFileSync(logPath, lines.join(''))
		const index = await backend.open()
		try {
			const log = { slug: SLUG, logPath, sessionId }
			expect((await index.getSession(sessionId))?.headSeq).toBe(4)
			expect(await index.staleness(log)).toBe('fresh')
			expect(await index.refresh(log)).toBe('fresh')
		} finally {
			index.close()
		}
	})

	it('reports a log it has not indexed, and indexes a new one on sync', async () => {
		const index = await backend.open()
		try {
			const { sessionId, text } = syntheticLog('late', 2)
			const logPath = join(home, 'projects', SLUG, `${sessionId}.jsonl`)
			writeFileSync(logPath, text)
			expect(await index.staleness({ slug: SLUG, logPath, sessionId })).toBe('unindexed')
			await index.sync(home)
			expect((await index.listTurns(sessionId)).length).toBe(2)
		} finally {
			index.close()
		}
	})
})

describe('SqliteSessionIndex: rebuild, never migrate', () => {
	it('rebuilds a missing index from the logs', async () => {
		expect(existsSync(path)).toBe(false)
		const index = await SqliteSessionIndex.open({ home, path })
		try {
			expect((await index.listSessions()).length).toBeGreaterThanOrEqual(12)
		} finally {
			index.close()
		}
		const db = new DatabaseSync(path, { readOnly: true })
		try {
			expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SESSION_INDEX_VERSION)
		} finally {
			db.close()
		}
		expect(readdirSync(home).filter((name) => name.includes('.tmp-'))).toEqual([])
	})

	it('rebuilds an index at another user_version', async () => {
		const db = new DatabaseSync(path)
		db.exec('CREATE TABLE sessions (id TEXT); PRAGMA user_version = 99;')
		db.close()
		const index = await SqliteSessionIndex.open({ home, path })
		try {
			expect((await index.listSessions()).length).toBeGreaterThanOrEqual(12)
		} finally {
			index.close()
		}
	})

	it('rebuilds a file that is not a database', async () => {
		writeFileSync(path, 'not a database, just bytes '.repeat(200))
		const index = await SqliteSessionIndex.open({ home, path })
		try {
			expect((await index.listSessions()).length).toBeGreaterThanOrEqual(12)
		} finally {
			index.close()
		}
	})

	it('keeps external_refs across a rebuild, non-UUID ids included', async () => {
		const first = await SqliteSessionIndex.open({ home, path })
		const before = await dump(first)
		const ref = await first.resolveExternal('a2a', 'context', 'ctx not a uuid')
		first.close()
		expect(ref?.sessionId).toBe(sid('origin'))

		rmSync(path)
		const second = await SqliteSessionIndex.open({ home, path })
		try {
			expect(await second.resolveExternal('a2a', 'context', 'ctx not a uuid')).toEqual(ref)
			expect(await dump(second)).toEqual(before)
		} finally {
			second.close()
		}
	})

	it('brings an existing index up to date with the logs when it opens', async () => {
		const first = await SqliteSessionIndex.open({ home, path })
		first.close()
		const { sessionId, text } = syntheticLog('after-close', 3)
		writeFileSync(join(home, 'projects', SLUG, `${sessionId}.jsonl`), text)
		unlinkSync(logOf('valid').logPath)
		const second = await SqliteSessionIndex.open({ home, path })
		try {
			expect((await second.listTurns(sessionId)).length).toBe(3)
			expect(await second.getSession(sid('valid'))).toBeUndefined()
		} finally {
			second.close()
		}
	})

	it('discards its own rebuild when a current index is already in place, unless forced', async () => {
		const first = await SqliteSessionIndex.open({ home, path })
		first.close()
		expect(await rebuildSqliteSessionIndex({ home, path })).toBe(false)
		expect(await rebuildSqliteSessionIndex({ home, path, force: true })).toBe(true)
		expect(readdirSync(home).filter((name) => name.includes('.tmp-'))).toEqual([])
	})

	it('removes the temporary files of a rebuild whose process died, and no other', async () => {
		const first = await SqliteSessionIndex.open({ home, path })
		first.close()
		// A pid that has exited: a process spawned and waited for.
		const dead = spawnSync(process.execPath, ['-e', '']).pid
		const abandoned = [`index.sqlite.tmp-${dead}-0190`, `index.sqlite.tmp-${dead}-0190-journal`]
		const live = `index.sqlite.tmp-${process.pid}-0191`
		for (const name of [...abandoned, live, 'unrelated.tmp-1-0192']) {
			writeFileSync(join(home, name), 'partial')
		}
		const second = await SqliteSessionIndex.open({ home, path })
		second.close()
		const left = () => readdirSync(home).filter((name) => name.includes('.tmp-'))
		expect(left().sort()).toEqual([live, 'unrelated.tmp-1-0192'])
		writeFileSync(join(home, abandoned[0] as string), 'partial')
		expect(await rebuildSqliteSessionIndex({ home, path, force: true })).toBe(true)
		expect(left().sort()).toEqual([live, 'unrelated.tmp-1-0192'])
	})

	it('never reads a UUID-named project directory, the old layout', async () => {
		const { text } = syntheticLog('legacy', 1)
		const legacy = join(home, 'projects', ids.project)
		mkdirSync(legacy, { recursive: true })
		const sessionId = JSON.parse(text.slice(0, text.indexOf('\n'))).sessionId as string
		writeFileSync(join(legacy, `${sessionId}.jsonl`), text)
		const logs = await discoverSessionLogs(home)
		expect(logs.some((log) => log.logPath.startsWith(legacy))).toBe(false)
	})
})

describe('openSessionIndex', () => {
	it('opens SQLite where node:sqlite loads, and the scan index when asked', async () => {
		const sqlite = await openSessionIndex({ home })
		const scan = await openSessionIndex({ home, backend: 'scan' })
		try {
			expect(sqlite.backend).toBe('sqlite')
			expect(scan.backend).toBe('scan')
			expect(existsSync(path)).toBe(true)
			expect(await dump(scan)).toEqual(await dump(sqlite))
		} finally {
			sqlite.close()
			scan.close()
		}
	})

	it('resolves the home from NAMZU_HOME when none is given', async () => {
		const previous = process.env.NAMZU_HOME
		process.env.NAMZU_HOME = home
		try {
			const index = await openSessionIndex({ backend: 'scan' })
			try {
				expect((await index.listSessions()).length).toBeGreaterThanOrEqual(12)
			} finally {
				index.close()
			}
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, 'NAMZU_HOME')
			else process.env.NAMZU_HOME = previous
		}
	})
})
