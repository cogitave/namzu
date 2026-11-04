import { describe, expect, it } from 'vitest'
import type { ProjectId, TenantId, TopicId } from '../../../types/ids/index.js'
import { generateMessageId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import { type LogMedium, SessionLogCore, type SessionLogWriteHealth } from '../core.js'
import type { SessionLease, SessionLog } from '../index.js'
import { InMemorySessionLeaseStore } from '../lease.js'
import { InMemoryLogMedium } from '../memory.js'
import { InMemorySpillStore } from '../spill.js'

type Draft = Parameters<SessionLog['append']>[1]

/** A medium whose volume can be filled and emptied, and which can leave half a record behind. */
class FullableMedium implements LogMedium {
	readonly inner = new InMemoryLogMedium()
	code: string | undefined
	/** Bytes of a refused record that still land, as a short write leaves them. */
	partial = 0
	size = () => this.inner.size()
	read = (offset: number, length: number) => this.inner.read(offset, length)
	stream = (offset: number) => this.inner.stream(offset)
	truncate = (size: number, expected: number) => this.inner.truncate(size, expected)
	async append(bytes: Uint8Array, expectedOffset: number, sync: boolean): Promise<void> {
		if (this.code !== undefined) {
			if (this.partial > 0) {
				await this.inner.append(bytes.subarray(0, this.partial), expectedOffset)
				this.partial = 0
			}
			throw Object.assign(new Error('write failed'), { code: this.code })
		}
		void sync
		await this.inner.append(bytes, expectedOffset)
	}
}

function open(options: { degradedBufferBytes?: number } = {}) {
	const medium = new FullableMedium()
	const sessionId = generateSessionId()
	const log = new SessionLogCore({
		sessionId,
		medium,
		leases: new InMemorySessionLeaseStore(),
		spills: new InMemorySpillStore(),
		sync: 'none',
		...options,
	})
	const changes: SessionLogWriteHealth[] = []
	log.onWriteHealth((change) => changes.push(change))
	return { log, medium, sessionId, changes }
}

async function begin(log: SessionLogCore) {
	const lease = (await log.claim({ holder: 'test', ttlMs: 60_000 })) as SessionLease
	await log.append(lease, {
		type: 'session_started',
		projectId: '4dfa889d-312b-4570-a8e3-e1ccd3f2274b' as ProjectId,
		tenantId: '2c8e25c0-8fc7-4427-8e9e-f338d6e51c02' as TenantId,
		topicId: '07c17470-7e89-4c5e-9680-2d10d92ac22a' as TopicId,
		cwd: '/tmp',
		agent: { id: 'a', name: 'A' },
	} as Draft)
	const turnId = generateTurnId()
	await log.beginTurn(lease, {
		turnId,
		userMessageId: generateMessageId(),
		config: { model: 'mock', tokenBudget: 0, timeoutMs: 0 },
	})
	return { lease, turnId }
}

const say = (log: SessionLogCore, lease: SessionLease, turnId: string, text: string) =>
	log.append(lease, {
		type: 'message',
		turnId,
		messageId: generateMessageId(),
		role: 'assistant',
		content: { role: 'assistant', content: text },
	} as unknown as Draft)

async function texts(log: SessionLogCore): Promise<string[]> {
	const read = await log.readAll()
	return read.entries.flatMap((e) => {
		const r = e.record as { type: string; content?: { content?: string } }
		return r.type === 'message' ? [String(r.content?.content)] : []
	})
}

describe('a full disk does not end the session', () => {
	it.each([
		['ENOSPC', 'disk_full'],
		['EDQUOT', 'quota_exceeded'],
		['EROFS', 'read_only'],
	])('keeps going when a write fails with %s and says so once', async (code, cause) => {
		const { log, medium, changes } = open()
		const { lease, turnId } = await begin(log)
		medium.code = code
		const first = await say(log, lease, turnId, 'one')
		const second = await say(log, lease, turnId, 'two')
		expect(second.record.seq).toBe(first.record.seq + 1)
		expect(second.record.prev?.seq).toBe(first.record.seq)
		expect(log.degraded).toBe(true)
		expect(changes).toEqual([
			{ state: 'degraded', cause, bufferedRecords: 1, bufferedBytes: expect.any(Number) },
		])
	})

	it('writes the waiting records in order when the disk has room, and says so once', async () => {
		const { log, medium, sessionId, changes } = open()
		const { lease, turnId } = await begin(log)
		await say(log, lease, turnId, 'saved')
		medium.code = 'ENOSPC'
		await say(log, lease, turnId, 'a')
		await say(log, lease, turnId, 'b')
		expect(await texts(log)).toEqual(['saved'])
		medium.code = undefined
		await say(log, lease, turnId, 'c')
		expect(log.degraded).toBe(false)
		expect(await texts(log)).toEqual(['saved', 'a', 'b', 'c'])
		await say(log, lease, turnId, 'd')
		expect(changes.map((c) => c.state)).toEqual(['degraded', 'recovered'])
		expect(changes[1]).toEqual({ state: 'recovered', flushedRecords: 3, droppedRecords: 0 })
		// The file is a whole chain a second reader accepts.
		const copy = new SessionLogCore({
			sessionId,
			medium,
			leases: new InMemorySessionLeaseStore(),
			spills: new InMemorySpillStore(),
		})
		expect((await copy.readAll()).intact).toBe(true)
	})

	it('cuts back the half of a record a refused write left behind', async () => {
		const { log, medium } = open()
		const { lease, turnId } = await begin(log)
		medium.code = 'ENOSPC'
		medium.partial = 20
		await say(log, lease, turnId, 'a')
		medium.code = undefined
		await say(log, lease, turnId, 'b')
		expect(await texts(log)).toEqual(['a', 'b'])
	})

	it('stays degraded while the disk is still full, retrying on each record', async () => {
		const { log, medium, changes } = open()
		const { lease, turnId } = await begin(log)
		medium.code = 'ENOSPC'
		for (const t of ['a', 'b', 'c']) await say(log, lease, turnId, t)
		expect(changes).toHaveLength(1)
		expect(log.degraded).toBe(true)
	})

	it('keeps the newest records within the byte bound and says once that it dropped', async () => {
		const { log, medium, changes } = open({ degradedBufferBytes: 2000 })
		const { lease, turnId } = await begin(log)
		medium.code = 'ENOSPC'
		const body = 'x'.repeat(500)
		for (let i = 0; i < 12; i++) await say(log, lease, turnId, `${i}:${body}`)
		const dropping = changes.filter((c) => c.state === 'degraded' && c.dropping)
		expect(dropping).toHaveLength(1)
		expect(changes.filter((c) => c.state === 'degraded')).toHaveLength(2)
		medium.code = undefined
		await say(log, lease, turnId, 'last')
		const recovered = changes.at(-1)
		expect(recovered).toMatchObject({ state: 'recovered' })
		expect((recovered as { droppedRecords: number }).droppedRecords).toBeGreaterThan(0)
		const all = await log.readAll({ mode: 'tolerant' })
		expect(all.entries.length).toBeGreaterThan(0)
	})

	it('does not swallow an error that is not a refused volume', async () => {
		const { log, medium } = open()
		const { lease, turnId } = await begin(log)
		medium.code = 'EIO'
		await expect(say(log, lease, turnId, 'a')).rejects.toMatchObject({ code: 'EIO' })
		expect(log.degraded).toBe(false)
	})

	it('drops a failing queued record when the flush hits a different error', async () => {
		const { log, medium } = open()
		const { lease, turnId } = await begin(log)
		medium.code = 'ENOSPC'
		await say(log, lease, turnId, 'a')
		medium.code = 'EIO'
		await expect(say(log, lease, turnId, 'b')).rejects.toMatchObject({ code: 'EIO' })
		medium.code = undefined
		const c = await say(log, lease, turnId, 'c')
		expect(await texts(log)).toEqual(['a', 'c'])
		expect(c.record.prev?.seq).toBe(c.record.seq - 1)
	})

	it('gives a body it cannot spill an honest preview instead of failing', async () => {
		const sessionId = generateSessionId()
		const medium = new FullableMedium()
		const spills = new InMemorySpillStore()
		const log = new SessionLogCore({
			sessionId,
			medium,
			leases: new InMemorySessionLeaseStore(),
			spills: {
				write: () => Promise.reject(Object.assign(new Error('full'), { code: 'ENOSPC' })),
				read: (ref, options) => spills.read(ref, options),
			},
			sync: 'none',
			spillAboveBytes: 4000,
		})
		const { lease, turnId } = await begin(log)
		const entry = await say(log, lease, turnId, 'y'.repeat(20_000))
		const content = (entry.record as unknown as { content: { content: string } }).content.content
		expect(content).toContain('could not be saved')
	})
})
