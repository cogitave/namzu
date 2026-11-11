import {
	appendFile,
	copyFile,
	mkdtemp,
	readFile,
	realpath,
	rename,
	stat,
	truncate,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import * as logHash from '../../../session/log-hash.js'
import { recordSha256 } from '../../../session/log-hash.js'
import {
	generateMessageId,
	generateProjectId,
	generateRecordId,
	generateSessionId,
	generateTurnId,
} from '../../../utils/id.js'
import { SessionLogIntegrityError } from '../chain.js'
import type { SessionRecordDraft } from '../core.js'
import { DiskLogMedium, DiskSessionLog, readSessionLog } from '../disk.js'
import { foldSessionLog } from '../incremental.js'
import { clearVerifiedPrefixes } from '../verified-prefix.js'

/**
 * A claim reads and hashes every byte of a log at every claim. What a process
 * has already verified in full is not parsed or schema-checked again: its
 * bytes are compared, by length and SHA-256, with the bytes that passed. The
 * parses are counted here, never timed.
 */
vi.mock('../../../session/log-hash.js', async (original) => {
	const actual = await original<typeof import('../../../session/log-hash.js')>()
	return { ...actual, parseSessionLogLine: vi.fn(actual.parseSessionLogLine) }
})

const parses = vi.mocked(logHash.parseSessionLogLine)

const made: string[] = []
afterAll(async () => {
	await removeTempDirs(made.splice(0))
})
beforeEach(() => {
	clearVerifiedPrefixes()
})

const started = {
	type: 'session_started',
	projectId: generateProjectId(),
	cwd: '/w',
	agent: { id: 'a', name: 'A' },
} as SessionRecordDraft

const update = (title: string) => ({ type: 'session_updated', title }) as SessionRecordDraft

async function newLog() {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-claim-hash-')))
	made.push(root)
	const sessionId = generateSessionId()
	const file = join(root, `${sessionId}.jsonl`)
	const sessionDir = join(root, sessionId)
	const open = () => new DiskSessionLog({ sessionId, file, sessionDir })
	return { root, sessionId, file, sessionDir, open }
}

/** A log of `records` records (the first is session_started), written by one instance, lease released. */
async function written(records: number, titlePrefix = 't') {
	const log = await newLog()
	const writer = log.open()
	const lease = await writer.claim({ holder: 'w', ttlMs: 60_000 })
	if (lease === null) throw new Error('claim failed')
	await writer.append(lease, started)
	for (let i = 1; i < records; i++) await writer.append(lease, update(`${titlePrefix}${i}`))
	await writer.release(lease)
	return log
}

async function claimAndRelease(log: DiskSessionLog, holder = 'c'): Promise<number> {
	const before = parses.mock.calls.length
	const lease = await log.claim({ holder, ttlMs: 60_000 })
	if (lease === null) throw new Error('claim refused')
	const used = parses.mock.calls.length - before
	await log.release(lease)
	return used
}

/** What a claim ends in, to compare a claim that remembers with one that does not. */
async function outcome(open: () => DiskSessionLog, file: string, holder: string) {
	const log = open()
	try {
		const lease = await log.claim({ holder, ttlMs: 60_000 })
		if (lease === null) return { claimed: false }
		const head = await log.head()
		const active = await log.activeTurn()
		await log.release(lease)
		return { claimed: true, head, active, size: (await stat(file)).size, fence: lease.fence }
	} catch (error) {
		if (error instanceof SessionLogIntegrityError) {
			return { refused: error.reason, seq: error.seq, offset: error.offset }
		}
		throw error
	}
}

describe('a claim in a process that already verified the log', () => {
	it('parses only what was appended since, however long the log is', async () => {
		const counts: { first: number; again: number; afterAppend: number }[] = []
		for (const n of [30, 120]) {
			const { file, open } = await written(n)
			clearVerifiedPrefixes()
			const first = await claimAndRelease(open())
			expect(first).toBeGreaterThanOrEqual(n)
			// Same process, a fresh instance, nothing appended: no record is parsed.
			const again = await claimAndRelease(open())
			// Another writer appends three records.
			const other = open()
			const lease = await other.claim({ holder: 'o', ttlMs: 60_000 })
			if (lease === null) throw new Error('claim failed')
			for (const t of ['x', 'y', 'z']) await other.append(lease, update(t))
			await other.release(lease)
			// A third instance in this process has seen them all (the writer remembers its records).
			const afterAppend = await claimAndRelease(open())
			counts.push({ first, again, afterAppend })
			expect((await readSessionLog(file)).entries).toHaveLength(n + 3)
		}
		const [small, large] = counts as [(typeof counts)[number], (typeof counts)[number]]
		// The first claim grows with the log (four times the records, four times the parses)...
		expect(large.first / small.first).toBeGreaterThan(3.5)
		// ...a later one does not grow at all.
		expect(large.again).toBe(small.again)
		expect(large.afterAppend).toBe(small.afterAppend)
		expect(large.again).toBeLessThanOrEqual(2)
	})

	it('parses exactly the records another process appended, and no others', async () => {
		const counts: number[] = []
		for (const n of [30, 120]) {
			const { file, sessionId, open } = await written(n)
			clearVerifiedPrefixes()
			await claimAndRelease(open())
			// A second process appends five records: this process never sees them written.
			const lines: string[] = []
			const head = (await open().head())?.pointer
			if (head === undefined) throw new Error('no head')
			let prev = head
			let seq = head.seq
			for (let i = 0; i < 5; i++) {
				seq += 1
				const line = `${JSON.stringify({
					v: 1,
					id: generateRecordId(),
					sessionId,
					seq,
					ts: new Date(0).toISOString(),
					prev,
					gen: 1,
					type: 'session_updated',
					title: `other${i}`,
				})}\n`
				const bytes = Buffer.from(line)
				prev = {
					seq,
					offset: prev.offset + prev.length,
					length: bytes.byteLength,
					sha256: recordSha256(bytes),
				}
				lines.push(line)
			}
			await appendFile(file, lines.join(''))
			counts.push(await claimAndRelease(open()))
			expect((await readSessionLog(file)).entries).toHaveLength(n + 5)
		}
		expect(counts[0]).toBe(counts[1])
		expect(counts[0]).toBeLessThanOrEqual(7)
	})

	it('refuses a same-length alteration in the middle after this process verified it, at the claim', async () => {
		const { file, open } = await written(40)
		await claimAndRelease(open())
		await writeFile(file, (await readFile(file, 'utf8')).replace('"title":"t17"', '"title":"t_7"'))
		const error = await open()
			.claim({ holder: 'x', ttlMs: 10 })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
		// The record after the altered one names the old bytes.
		expect(error).toMatchObject({ reason: 'prev-mismatch', seq: 19 })
	})

	it.each([
		['the first record', '"cwd":"/w"', '"cwd":"/x"'],
		['a middle record', '"title":"t20"', '"title":"t_0"'],
		['the second last record', '"title":"t38"', '"title":"t_8"'],
	])('refuses a byte changed in %s as a log with no memory does', async (_name, from, to) => {
		const { file, open } = await written(40)
		await claimAndRelease(open())
		await writeFile(file, (await readFile(file, 'utf8')).replace(from, to))
		const remembered = await outcome(open, file, 'a')
		clearVerifiedPrefixes()
		const forgotten = await outcome(open, file, 'b')
		expect(remembered).toMatchObject({ refused: expect.any(String) })
		expect(remembered).toEqual(forgotten)
	})

	it('treats a changed last record as a log with no memory does (nothing follows it to vouch for it)', async () => {
		const { file, open } = await written(40)
		await claimAndRelease(open())
		await writeFile(file, (await readFile(file, 'utf8')).replace('"title":"t39"', '"title":"t_9"'))
		const remembered = await outcome(open, file, 'a')
		clearVerifiedPrefixes()
		const forgotten = await outcome(open, file, 'b')
		expect(remembered.claimed).toBe(true)
		expect(remembered).toEqual({ ...forgotten, fence: remembered.fence })
	})

	it('refuses a record a second writer appended with a wrong shape and a consistent hash, at the claim', async () => {
		const { file, sessionId, open } = await written(25)
		await claimAndRelease(open())
		const head = (await open().head())?.pointer
		if (head === undefined) throw new Error('no head')
		const bad = Buffer.from(
			`${JSON.stringify({
				v: 1,
				id: generateRecordId(),
				sessionId,
				seq: head.seq + 1,
				ts: new Date(0).toISOString(),
				prev: head,
				gen: 1,
				type: 'session_updated',
				title: 5,
			})}\n`,
		)
		await appendFile(file, bad)
		const error = await open()
			.claim({ holder: 'x', ttlMs: 10 })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SessionLogIntegrityError)
		expect(error).toMatchObject({ reason: 'not-a-record', seq: head.seq + 1 })
		// A reader refuses it too.
		await expect(readSessionLog(file)).rejects.toBeInstanceOf(SessionLogIntegrityError)
		// And again at the next claim: nothing was remembered of it.
		await expect(open().claim({ holder: 'y', ttlMs: 10 })).rejects.toBeInstanceOf(
			SessionLogIntegrityError,
		)
	})

	it('re-verifies a truncated log in full and takes what is left, as a log with no memory does', async () => {
		const { file, open } = await written(40)
		await claimAndRelease(open())
		const lines = (await readFile(file, 'utf8')).split('\n')
		const keep = `${lines.slice(0, 25).join('\n')}\n`
		await truncate(file, Buffer.byteLength(keep))
		const remembered = await outcome(open, file, 'a')
		clearVerifiedPrefixes()
		const forgotten = await outcome(open, file, 'b')
		expect(remembered).toMatchObject({ claimed: true, head: { pointer: { seq: 25 } } })
		expect(remembered).toEqual({ ...forgotten, fence: (remembered as { fence: number }).fence })
	})

	it('cuts a torn tail the way a log with no memory does', async () => {
		const { file, open } = await written(30)
		await claimAndRelease(open())
		await appendFile(file, '{"v":1,"type":"audit","id":"tor')
		const lease = await open().claim({ holder: 'x', ttlMs: 60_000 })
		expect(lease).not.toBeNull()
		const read = await readSessionLog(file)
		expect(read.entries.at(-1)?.record).toMatchObject({ type: 'log_repaired', lastGoodSeq: 30 })
		expect(read.tornBytes).toBe(0)
	})

	it('refuses a truncation inside a record the same way', async () => {
		const { file, open } = await written(30)
		await claimAndRelease(open())
		const size = (await stat(file)).size
		await truncate(file, size - 10)
		const lease = await open().claim({ holder: 'x', ttlMs: 60_000 })
		expect(lease).not.toBeNull()
		expect((await readSessionLog(file)).entries.at(-1)?.record.type).toBe('log_repaired')
	})

	it('refuses a replaced file of the same size that is not the log, and takes one that is a log', async () => {
		const { root, file, open } = await written(30)
		await claimAndRelease(open())
		const size = (await stat(file)).size
		// Garbage of the same size, put in place by a rename (a new inode).
		const junk = join(root, 'junk')
		await writeFile(junk, `${'a'.repeat(size - 1)}\n`)
		await rename(junk, file)
		expect((await stat(file)).size).toBe(size)
		await expect(open().claim({ holder: 'x', ttlMs: 10 })).rejects.toBeInstanceOf(
			SessionLogIntegrityError,
		)
	})

	it('takes a replaced file of the same size that is another valid log, with its own turn state', async () => {
		const first = await written(30, 't')
		// A second log of the same session id and the same record count, whose last record opens a turn.
		const sessionId = first.sessionId
		const other = join(first.root, 'other')
		const otherFile = join(other, `${sessionId}.jsonl`)
		const writer = new DiskSessionLog({
			sessionId,
			file: otherFile,
			sessionDir: join(other, sessionId),
		})
		const lease = await writer.claim({ holder: 'w', ttlMs: 60_000 })
		if (lease === null) throw new Error('claim failed')
		await writer.append(lease, started)
		for (let i = 1; i < 29; i++) await writer.append(lease, update(`t${i}`))
		const turnId = generateTurnId()
		await writer.beginTurn(lease, {
			turnId,
			userMessageId: generateMessageId(),
			config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
		})
		await writer.release(lease)
		await claimAndRelease(first.open())
		const sizeBefore = (await stat(first.file)).size
		await copyFile(otherFile, `${first.file}.new`)
		await rename(`${first.file}.new`, first.file)
		expect(Math.abs((await stat(first.file)).size - sizeBefore)).toBeLessThan(2000)
		const reopened = first.open()
		const taken = await reopened.claim({ holder: 'x', ttlMs: 60_000 })
		expect(taken).not.toBeNull()
		expect((await reopened.activeTurn({ lease: taken ?? undefined }))?.turnId).toBe(turnId)
		expect((await readSessionLog(first.file)).entries).toHaveLength(30)
	})

	it('answers the active turn from the remembered turn state, as a full verification does', async () => {
		const { open } = await written(10)
		const writer = open()
		const lease = await writer.claim({ holder: 'w', ttlMs: 60_000 })
		if (lease === null) throw new Error('claim failed')
		const turnId = generateTurnId()
		await writer.beginTurn(lease, {
			turnId,
			userMessageId: generateMessageId(),
			config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
		})
		await writer.release(lease)
		const remembered = await open().activeTurn({ now: Date.now() + 10 * 60_000 })
		clearVerifiedPrefixes()
		const forgotten = await open().activeTurn({ now: Date.now() + 10 * 60_000 })
		expect(remembered).toMatchObject({ turnId, state: 'interrupted' })
		expect(remembered).toEqual(forgotten)
	})

	it('hashes every byte: a same-length change anywhere is refused at a claim, at every position tried', async () => {
		const { file, open } = await written(24)
		await claimAndRelease(open())
		const original = await readFile(file)
		const lineStarts: number[] = [0]
		for (let i = 0; i < original.length - 1; i++) if (original[i] === 0x0a) lineStarts.push(i + 1)
		// The last line has no successor to vouch for it; every other line does.
		for (const start of lineStarts.slice(0, -1).filter((_, i) => i % 3 === 0)) {
			const altered = Buffer.from(original)
			// A digit of the record's own `ts` year, which keeps the line valid JSON of the same length.
			const at = altered.indexOf('"ts":"20', start) + 7
			altered[at] = altered[at] === 0x32 ? 0x31 : 0x32
			await writeFile(file, altered)
			await expect(open().claim({ holder: 'x', ttlMs: 10 })).rejects.toBeInstanceOf(
				SessionLogIntegrityError,
			)
			await writeFile(file, original)
			expect(await claimAndRelease(open(), 'again')).toBeLessThanOrEqual(30)
		}
	})

	it('re-checks a log longer than one read chunk, records spanning chunk boundaries included', async () => {
		// About 5 MiB in lines of about 2.5 KiB: several 1 MiB reads, lines straddling each boundary.
		const body = 'x'.repeat(2400)
		const { file, open } = await written(2000, `${body}-`)
		expect((await stat(file)).size).toBeGreaterThan(4 * 1024 * 1024)
		await claimAndRelease(open())
		expect(await claimAndRelease(open())).toBeLessThanOrEqual(2)
		const text = await readFile(file, 'utf8')
		for (const index of [1, 420, 421, 1000, 1700]) {
			const marker = `"title":"${body}-${index}"`
			expect(text.includes(marker)).toBe(true)
			await writeFile(file, text.replace(marker, `"title":"${body}_${index}"`))
			await expect(open().claim({ holder: 'x', ttlMs: 10 })).rejects.toBeInstanceOf(
				SessionLogIntegrityError,
			)
			await writeFile(file, text)
			expect(await claimAndRelease(open(), 'ok')).toBeLessThanOrEqual(2000)
		}
	})

	it('re-checks through a medium that cannot scan, with the same answers', async () => {
		const { file, open } = await written(60)
		const scan = DiskLogMedium.prototype.scan
		try {
			// biome-ignore lint/performance/noDelete: removes the optional member for this test
			delete (DiskLogMedium.prototype as { scan?: unknown }).scan
			await claimAndRelease(open())
			expect(await claimAndRelease(open())).toBeLessThanOrEqual(2)
			await writeFile(
				file,
				(await readFile(file, 'utf8')).replace('"title":"t30"', '"title":"t_0"'),
			)
			await expect(open().claim({ holder: 'x', ttlMs: 10 })).rejects.toBeInstanceOf(
				SessionLogIntegrityError,
			)
		} finally {
			DiskLogMedium.prototype.scan = scan
		}
	})

	it('lets the next holder take over a log the previous holder wrote, remembering it', async () => {
		const { open } = await written(30)
		const a = open()
		const leaseA = await a.claim({ holder: 'a', ttlMs: 10, now: 0 })
		if (leaseA === null) throw new Error('claim failed')
		await a.append(leaseA, update('a'))
		const b = open()
		const leaseB = await b.claim({ holder: 'b', ttlMs: 10, now: 1000 })
		expect(leaseB?.fence).toBeGreaterThan(leaseA.fence)
		if (leaseB === null) throw new Error('claim failed')
		await b.append(leaseB, update('b'))
		expect(
			(await readSessionLog((b as unknown as { file: string }).file)).entries.at(-1)?.record.gen,
		).toBe(leaseB.fence)
	})
})

describe('a resumed strict reduction that re-verifies', () => {
	const titles = (counter: { applied: number }, reverify: boolean) =>
		({
			name: `titles-${reverify}`,
			mode: 'strict',
			reverify,
			create: () => [] as string[],
			apply: (list: string[], entry: { record: { type: string; title?: unknown } }) => {
				counter.applied++
				if (entry.record.type === 'session_updated') list.push(String(entry.record.title))
			},
			result: (list: string[]) => [...list],
		}) as const

	it('parses nothing it already verified, and refuses a log altered in the middle', async () => {
		const parsed: number[] = []
		for (const n of [30, 120]) {
			const { file, open } = await written(n)
			const log = open()
			const counter = { applied: 0 }
			await foldSessionLog(log, titles(counter, true))
			const before = parses.mock.calls.length
			await foldSessionLog(log, titles(counter, true))
			parsed.push(parses.mock.calls.length - before)
			await writeFile(
				file,
				(await readFile(file, 'utf8')).replace('"title":"t10"', '"title":"t_0"'),
			)
			await expect(foldSessionLog(log, titles(counter, true))).rejects.toBeInstanceOf(
				SessionLogIntegrityError,
			)
		}
		expect(parsed[0]).toBe(parsed[1])
		expect(parsed[0]).toBeLessThanOrEqual(2)
	})

	it('remembers what its first whole read verified, so the second one parses nothing old', async () => {
		const parsed: { first: number; second: number }[] = []
		for (const n of [30, 120]) {
			const { open } = await written(n)
			clearVerifiedPrefixes()
			const log = open()
			const counter = { applied: 0 }
			const before = parses.mock.calls.length
			await foldSessionLog(log, titles(counter, true))
			const first = parses.mock.calls.length - before
			await foldSessionLog(log, titles(counter, true))
			parsed.push({ first, second: parses.mock.calls.length - before - first })
		}
		expect(parsed[1]?.first).toBeGreaterThan((parsed[0]?.first ?? 0) * 3.5)
		expect(parsed[0]?.second).toBe(parsed[1]?.second)
		expect(parsed[0]?.second).toBeLessThanOrEqual(2)
	})

	it('without it, a resumed read trusts the prefix (the documented window)', async () => {
		const { file, open } = await written(30)
		const log = open()
		const counter = { applied: 0 }
		await foldSessionLog(log, titles(counter, false))
		await writeFile(file, (await readFile(file, 'utf8')).replace('"title":"t10"', '"title":"t_0"'))
		await expect(foldSessionLog(log, titles(counter, false))).resolves.toHaveLength(29)
	})

	it('verifies in full the first time a process meets the log, and refuses a broken one', async () => {
		const { file, open } = await written(30)
		await writeFile(file, (await readFile(file, 'utf8')).replace('"title":"t10"', '"title":"t_0"'))
		clearVerifiedPrefixes()
		await expect(foldSessionLog(open(), titles({ applied: 0 }, true))).rejects.toBeInstanceOf(
			SessionLogIntegrityError,
		)
	})
})
