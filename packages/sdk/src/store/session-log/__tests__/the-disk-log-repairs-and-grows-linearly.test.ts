import { appendFile, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { SessionId } from '../../../types/ids/index.js'
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
} from '../../../utils/id.js'
import { SessionLogIntegrityError } from '../chain.js'
import type { SessionRecordDraft } from '../core.js'
import { DiskLogMedium, DiskSessionLog, readSessionLog } from '../disk.js'
import { InMemorySessionLeaseStore, StaleSessionLeaseError, readSessionLease } from '../lease.js'
import { InMemorySessionLog } from '../memory.js'

const made: string[] = []
afterAll(async () => {
	await removeTempDirs(made.splice(0))
})

async function newLog(options: { sync?: 'boundaries' | 'all' | 'none' } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-disk-log-')))
	made.push(root)
	const sessionId = generateSessionId()
	const file = join(root, `${sessionId}.jsonl`)
	const sessionDir = join(root, sessionId)
	const open = () => new DiskSessionLog({ sessionId, file, sessionDir, ...options })
	return { sessionId, file, sessionDir, open }
}

const started = {
	type: 'session_started',
	projectId: generateProjectId(),
	cwd: '/w',
	agent: { id: 'a', name: 'A' },
} as SessionRecordDraft

describe('the disk log', () => {
	it('cuts a torn tail when the next writer takes the lease, and records the cut', async () => {
		const { file, open } = await newLog()
		const log = open()
		const lease = await log.claim({ holder: 'a', ttlMs: 10, now: 0 })
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, started)
		await appendFile(file, '{"v":1,"type":"audit","id":"tor')
		const next = open()
		const taken = await next.claim({ holder: 'b', ttlMs: 10, now: 100 })
		expect(taken?.fence).toBe(2)
		const text = await readFile(file, 'utf8')
		expect(text.endsWith('\n')).toBe(true)
		const read = await readSessionLog(file)
		expect(read.entries.map((e) => e.record.type)).toEqual(['session_started', 'log_repaired'])
		expect(read.entries[1]?.record).toMatchObject({ truncatedBytes: 31, lastGoodSeq: 1, gen: 2 })
		expect(read.entries[1]?.record.turnId).toBe(undefined)
	})

	it('cuts a log torn inside its first record to nothing, and the session can start again', async () => {
		const { file, open } = await newLog()
		await writeFile(file, '{"v":1,"type":"session_sta')
		const log = open()
		const lease = await log.claim({ holder: 'a', ttlMs: 1000 })
		if (lease === null) throw new Error('claim failed')
		expect(await readFile(file, 'utf8')).toBe('')
		await log.append(lease, started)
		expect((await readSessionLog(file)).entries).toHaveLength(1)
	})

	it('refuses to take a log whose chain is broken, and leaves the lease free', async () => {
		const { file, open, sessionDir } = await newLog()
		const log = open()
		const lease = await log.claim({ holder: 'a', ttlMs: 10, now: 0 })
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, started)
		await log.append(lease, { type: 'session_updated', title: 'one' } as SessionRecordDraft)
		await log.append(lease, { type: 'session_updated', title: 'two' } as SessionRecordDraft)
		// Same length, still a valid record: only the next record's prev can tell.
		await writeFile(file, (await readFile(file, 'utf8')).replace('"title":"one"', '"title":"eno"'))
		await expect(open().claim({ holder: 'b', ttlMs: 10, now: 100 })).rejects.toBeInstanceOf(
			SessionLogIntegrityError,
		)
		// The failed taker released what it claimed: a tombstone is the current holding.
		expect((await readSessionLease(sessionDir))?.holder).toBe('')
	})

	it('mints a fence above the log after its lease files are gone, and the log stays whole', async () => {
		const { file, sessionDir, open } = await newLog()
		for (const [i, holder] of ['a', 'b', 'c'].entries()) {
			const log = open()
			const lease = await log.claim({ holder, ttlMs: 10, now: i * 100 })
			if (lease === null) throw new Error('claim failed')
			if ((await log.head()) === null) await log.append(lease, started)
			await log.append(lease, { type: 'session_updated', title: holder } as SessionRecordDraft)
		}
		expect((await readSessionLog(file)).entries.map((e) => e.record.gen)).toEqual([1, 1, 2, 3])
		// `<session-id>/` holds tool results and checkpoints too; an operator may clear it.
		await rm(sessionDir, { recursive: true })
		const log = open()
		const lease = await log.claim({ holder: 'd', ttlMs: 60_000 })
		expect(lease?.fence).toBe(4)
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, { type: 'session_updated', title: 'd' } as SessionRecordDraft)
		const read = await readSessionLog(file, { mode: 'tolerant' })
		expect(read.intact).toBe(true)
		expect(read.entries.map((e) => e.record.gen)).toEqual([1, 1, 2, 3, 4])
		expect(await open().claim({ holder: 'e', ttlMs: 10, now: Date.now() + 120_000 })).not.toBe(null)
	})

	it('refuses a lease below the log head before writing anything', async () => {
		const sessionId = generateSessionId()
		const log = new InMemorySessionLog({ sessionId })
		const first = await log.claim({ holder: 'a', ttlMs: 10, now: 0 })
		if (first === null) throw new Error('claim failed')
		await log.append(first, started)
		await log.release(first)
		const second = await log.claim({ holder: 'b', ttlMs: 60_000, now: 1 })
		if (second === null) throw new Error('claim failed')
		await log.append(second, { type: 'session_updated', title: 'b' } as SessionRecordDraft)
		// A lease store that lost its state hands out fence 1 again, bypassing the log's floor.
		const forgetful = new InMemorySessionLeaseStore()
		const low = await forgetful.claim({ holder: 'c', ttlMs: 60_000, now: 2 })
		if (low === null) throw new Error('claim failed')
		const reader = new InMemorySessionLog({ sessionId, medium: log.medium, leases: forgetful })
		const before = log.medium.bytes()
		await expect(
			reader.append(low, { type: 'session_updated', title: 'c' } as SessionRecordDraft),
		).rejects.toBeInstanceOf(StaleSessionLeaseError)
		expect(log.medium.bytes().equals(before)).toBe(true)
		expect((await reader.readAll()).intact).toBe(true)
	})

	it('refuses an append when another writer changed the file underneath it', async () => {
		const { file, open } = await newLog()
		const log = open()
		const lease = await log.claim({ holder: 'a', ttlMs: 60_000 })
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, started)
		const medium = new DiskLogMedium(file)
		const size = await medium.size()
		await expect(medium.append(Buffer.from('x\n'), size - 1, false)).rejects.toThrow(
			/Another writer appended/,
		)
	})

	it('grows linearly over 200 iterations and never re-reads the log to append', async () => {
		const { file, open } = await newLog({ sync: 'none' })
		const log = open()
		const lease = await log.claim({ holder: 'a', ttlMs: 600_000 })
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, started)
		const turnId = generateTurnId()
		await log.beginTurn(lease, {
			turnId,
			userMessageId: generateMessageId(),
			config: { model: 'm', tokenBudget: 1, timeoutMs: 1 },
		})
		const stream = vi.spyOn(DiskLogMedium.prototype, 'stream')
		const read = vi.spyOn(DiskLogMedium.prototype, 'read')
		const sizes: number[] = []
		try {
			for (let i = 1; i <= 200; i++) {
				await log.append(lease, {
					type: 'iteration_started',
					turnId,
					iteration: i,
				} as SessionRecordDraft)
				await log.append(lease, {
					type: 'message',
					turnId,
					messageId: generateMessageId(),
					role: 'assistant',
					content: { role: 'assistant', content: `answer ${String(i).padStart(4, '0')}` },
				} as SessionRecordDraft)
				await log.append(lease, {
					type: 'iteration_completed',
					turnId,
					iteration: i,
					hasToolCalls: false,
				} as SessionRecordDraft)
				sizes.push((await readFile(file)).byteLength)
			}
			expect(stream).not.toHaveBeenCalled()
			expect(read).not.toHaveBeenCalled()
		} finally {
			stream.mockRestore()
			read.mockRestore()
		}
		const deltas = sizes.slice(1).map((size, i) => size - (sizes[i] as number))
		// Each iteration adds the same records; only the digits of seq, offset
		// and iteration grow, so the per-iteration cost is flat.
		expect(Math.max(...deltas) / Math.min(...deltas)).toBeLessThan(1.05)
		expect((await readSessionLog(file)).entries).toHaveLength(2 + 600)
	})

	it('reads a session through the layout helper', async () => {
		const { SessionPaths } = await import('../../../session/paths.js')
		const home = await realpath(await mkdtemp(join(tmpdir(), 'namzu-disk-home-')))
		made.push(home)
		const paths = new SessionPaths({ home, slug: '-w' })
		const sessionId: SessionId = generateSessionId()
		const log = DiskSessionLog.at(paths, { sessionId })
		expect(log.file).toBe(paths.sessionLog({ sessionId }))
		expect(log.sessionDir).toBe(paths.sessionDir({ sessionId }))
		const lease = await log.claim({ holder: 'a', ttlMs: 1000 })
		if (lease === null) throw new Error('claim failed')
		await log.append(lease, started)
		expect((await readSessionLog(log.file, { sessionId })).intact).toBe(true)
	})
})
