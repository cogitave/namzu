import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readIndexableRecords } from '../rebuild.js'
import { ScanSessionIndex } from '../scan.js'
import { SqliteSessionIndex } from '../sqlite.js'
import { SLUG, dump, syntheticLog } from './support.js'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
// Built output, not source: separate node processes with no loader.
const dist = join(here, '..', '..', '..', '..', 'dist')

const SESSIONS = 80
const TURNS = 12

let root: string
let home: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-session-index-race-'))
	home = join(root, 'home')
	const project = join(home, 'projects', SLUG)
	mkdirSync(project, { recursive: true })
	for (let i = 0; i < SESSIONS; i++) {
		const { sessionId, text } = syntheticLog(`race-${i}`, TURNS)
		writeFileSync(join(project, `${sessionId}.jsonl`), text)
	}
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

/**
 * [C7.10] Two (and four) processes find no index and rebuild it at the same
 * moment. Each builds a complete index in its own temporary file; whichever
 * renames first wins, and a later one finds a current index in place and
 * discards its own. Every process finishes, one index remains, and it holds
 * every session.
 */
describe('processes that rebuild the index at the same time', () => {
	it.each([2, 4])(
		'%i processes all finish and leave one complete index',
		async (workers) => {
			expect(existsSync(join(dist, 'store', 'session-index', 'index.js'))).toBe(true)
			const path = join(home, 'index.sqlite')
			let overlapped = 0
			// Several rounds: each release is one chance for the builds to overlap.
			for (let round = 0; round < 3; round++) {
				rmSync(path, { force: true })
				const at = String(Date.now() + 1_500)
				const results = await Promise.all(
					Array.from({ length: workers }, () =>
						exec(process.execPath, [join(here, 'rebuild-worker.mjs'), dist, home, path, at]),
					),
				)
				const reports = results.map(
					(result) =>
						JSON.parse(result.stdout.trim()) as {
							ok: boolean
							sessions: number
							turns: number
							won: boolean
							startedAt: number
							endedAt: number
						},
				)
				for (const report of reports) {
					expect(report).toMatchObject({ ok: true, sessions: SESSIONS, turns: SESSIONS * TURNS })
				}
				// At least one rename won; every other build was discarded or renamed a complete file.
				expect(reports.some((report) => report.won)).toBe(true)
				const latestStart = Math.max(...reports.map((report) => report.startedAt))
				const earliestEnd = Math.min(...reports.map((report) => report.endedAt))
				if (latestStart < earliestEnd) overlapped++
				const left = readdirSync(home).filter((name) => name.startsWith('index.sqlite'))
				expect(left).toEqual(['index.sqlite'])
			}

			// The race has to have happened for the test to mean anything.
			expect(overlapped).toBeGreaterThan(0)

			const sqlite = await SqliteSessionIndex.open({ home, path })
			const scan = await ScanSessionIndex.load(home)
			try {
				expect(await dump(sqlite)).toEqual(await dump(scan))
				const context = await sqlite.resolveExternal('a2a', 'context', 'ctx-race-7')
				expect(context?.sessionId).toBeDefined()
			} finally {
				sqlite.close()
				scan.close()
			}
		},
		120_000,
	)
})

interface WorkerReport {
	ok: boolean
	sessions: number
	turns: number
}

/**
 * [C7.10] Incremental writes race too: connections that bring one existing
 * index up to date with logs that grew continue the same sessions from the
 * same heads. The one that finds a session already advanced by another stands
 * down; it never refuses the records as a gap.
 */
describe('connections that continue the same grown logs at once', () => {
	it('stands down when another connection advanced the session first', async () => {
		const project = join(home, 'projects', SLUG)
		const small = syntheticLog('grow', 2)
		const big = syntheticLog('grow', 4)
		expect(big.text.startsWith(small.text)).toBe(true)
		const logPath = join(project, `${small.sessionId}.jsonl`)
		writeFileSync(logPath, small.text)
		const path = join(home, 'index.sqlite')
		const a = await SqliteSessionIndex.open({ home, path })
		const b = await SqliteSessionIndex.open({ home, path })
		try {
			writeFileSync(logPath, big.text)
			const log = { slug: SLUG, logPath, sessionId: small.sessionId }
			expect(await a.staleness(log)).toBe('grown')
			// What a refresh does: read the head, then continue from it.
			const head = await a.getSession(small.sessionId)
			if (head === undefined) throw new Error('not indexed')
			const records = readIndexableRecords(logPath, {
				offset: head.logBytes,
				seq: head.headSeq,
				sha256: head.headSha256,
			})
			// Another connection continues the same session first.
			expect(await b.refresh(log)).toBe('grown')
			const after = await a.indexSession({ slug: SLUG, logPath, records })
			expect(after?.headSeq).toBe(1 + 4 * 4)
			expect(await a.listTurns(small.sessionId)).toHaveLength(4)
			expect(await a.staleness(log)).toBe('fresh')
		} finally {
			a.close()
			b.close()
		}
	})

	it('4 processes that open an index over grown logs all finish', async () => {
		expect(existsSync(join(dist, 'store', 'session-index', 'index.js'))).toBe(true)
		const project = join(home, 'projects', SLUG)
		const path = join(home, 'index.sqlite')
		const grown = 40
		;(await SqliteSessionIndex.open({ home, path })).close()
		for (let round = 1; round <= 3; round++) {
			// Each round lengthens the same logs; the index still holds the last round's heads.
			for (let i = 0; i < grown; i++) {
				const { sessionId, text } = syntheticLog(`race-${i}`, TURNS + round * 40)
				writeFileSync(join(project, `${sessionId}.jsonl`), text)
			}
			const at = String(Date.now() + 1_500)
			const results = await Promise.all(
				Array.from({ length: 4 }, () =>
					exec(process.execPath, [join(here, 'rebuild-worker.mjs'), dist, home, path, at, 'open']),
				),
			)
			const turns = grown * (TURNS + round * 40) + (SESSIONS - grown) * TURNS
			for (const result of results) {
				expect(JSON.parse(result.stdout.trim()) as WorkerReport).toMatchObject({
					ok: true,
					sessions: SESSIONS,
					turns,
				})
			}
		}
		const sqlite = await SqliteSessionIndex.open({ home, path })
		const scan = await ScanSessionIndex.load(home)
		try {
			expect(await dump(sqlite)).toEqual(await dump(scan))
		} finally {
			sqlite.close()
			scan.close()
		}
	}, 120_000)
})
