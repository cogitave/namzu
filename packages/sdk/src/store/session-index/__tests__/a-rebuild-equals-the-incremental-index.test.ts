import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionId } from '../../../types/ids/index.js'
import type { IndexableRecord, SessionIndex } from '../index.js'
import { discoverSessionLogs, readIndexableRecords } from '../rebuild.js'
import { ScanSessionIndex } from '../scan.js'
import { SqliteSessionIndex } from '../sqlite.js'
import { dump, homeWithFixtures } from './support.js'

let root: string
let home: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-session-index-'))
	home = join(root, 'home')
	homeWithFixtures(home)
})

afterEach(() => {
	rmSync(root, { recursive: true, force: true })
})

async function collect(path: string): Promise<IndexableRecord[]> {
	const records: IndexableRecord[] = []
	for await (const item of readIndexableRecords(path)) records.push(item)
	return records
}

type Backend = { name: string; open(path: string): Promise<SessionIndex> }

const backends: Backend[] = [
	{
		name: 'sqlite',
		open: (path) => SqliteSessionIndex.open({ home: join(root, 'empty-home'), path }),
	},
	{ name: 'scan', open: async () => new ScanSessionIndex() },
]

describe.each(backends)('$name: a rebuild equals the incremental index', (backend) => {
	it('gives the same answers whether each log is indexed whole or in pieces', async () => {
		const logs = await discoverSessionLogs(home)
		expect(logs.length).toBeGreaterThanOrEqual(12)

		const whole = await backend.open(join(root, 'whole.sqlite'))
		const pieces = await backend.open(join(root, 'pieces.sqlite'))
		try {
			for (const log of logs) {
				const records = await collect(log.logPath)
				await whole.indexSession({ slug: log.slug, logPath: log.logPath, records })
				// Three pieces at uneven cuts, each continuing from the indexed head.
				const cuts = [0, 1, Math.ceil(records.length / 2), records.length]
				for (let i = 0; i + 1 < cuts.length; i++) {
					const piece = records.slice(cuts[i], cuts[i + 1])
					if (piece.length === 0) continue
					await pieces.indexSession({ slug: log.slug, logPath: log.logPath, records: piece })
				}
			}
			expect(await dump(pieces)).toEqual(await dump(whole))
		} finally {
			whole.close()
			pieces.close()
		}
	})

	it('gives the same answers after a log grows on disk and is refreshed', async () => {
		const logs = await discoverSessionLogs(home)
		const reference = await backend.open(join(root, 'reference.sqlite'))
		const growing = await backend.open(join(root, 'growing.sqlite'))
		try {
			for (const log of logs) await reference.refresh(log)
			// Every log cut back to about a third of its lines, indexed, then regrown.
			const full = new Map(logs.map((log) => [log.logPath, readFileSync(log.logPath, 'utf8')]))
			for (const log of logs) {
				const text = full.get(log.logPath) as string
				const lines = text.split(/(?<=\n)/)
				writeFileSync(
					log.logPath,
					lines.slice(0, Math.max(1, Math.floor(lines.length / 3))).join(''),
				)
			}
			for (const log of logs) await growing.refresh(log)
			for (const log of logs) {
				const text = full.get(log.logPath) as string
				appendFileSync(log.logPath, text.slice(readFileSync(log.logPath).byteLength))
			}
			const states = []
			for (const log of logs) states.push(await growing.refresh(log))
			expect(states.filter((state) => state === 'grown').length).toBeGreaterThan(0)
			expect(await dump(growing)).toEqual(await dump(reference))
		} finally {
			reference.close()
			growing.close()
		}
	})

	it('refuses records that do not continue the indexed head', async () => {
		const [log] = await discoverSessionLogs(home)
		if (log === undefined) throw new Error('no fixture log')
		const records = await collect(log.logPath)
		const index = await backend.open(join(root, 'refuse.sqlite'))
		try {
			await expect(
				index.indexSession({ slug: log.slug, logPath: log.logPath, records: records.slice(2) }),
			).rejects.toThrow(/does not continue the indexed head/)
			await index.indexSession({
				slug: log.slug,
				logPath: log.logPath,
				records: records.slice(0, 3),
			})
			await expect(
				index.indexSession({ slug: log.slug, logPath: log.logPath, records: records.slice(4) }),
			).rejects.toThrow(/does not continue the indexed head/)
			const swapped = [records[0], records[2], records[1]] as IndexableRecord[]
			await expect(
				index.indexSession({ slug: log.slug, logPath: log.logPath, records: swapped }),
			).rejects.toThrow(/does not chain/)
			const session = await index.getSession(log.sessionId as SessionId)
			expect(session?.headSeq).toBe(3)
		} finally {
			index.close()
		}
	})
})

describe('ScanSessionIndex gives the same answers as SqliteSessionIndex', () => {
	it('over every fixture', async () => {
		const sqlite = await SqliteSessionIndex.open({ home, path: join(root, 'index.sqlite') })
		const scan = await ScanSessionIndex.load(home)
		try {
			expect(sqlite.backend).toBe('sqlite')
			expect(scan.backend).toBe('scan')
			const answers = await dump(sqlite)
			expect(await dump(scan)).toEqual(answers)
			expect((answers as { sessions: unknown[] }).sessions.length).toBeGreaterThanOrEqual(12)
		} finally {
			sqlite.close()
			scan.close()
		}
	})
})
