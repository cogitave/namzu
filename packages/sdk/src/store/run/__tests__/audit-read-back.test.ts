import { appendFile, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { AuditEvent } from '../../../types/run/audit.js'
import type { RunStore } from '../../../types/run/store.js'
import { RunDiskStore } from '../disk.js'
import { InMemoryRunStore } from '../memory.js'

/**
 * The audit trail's own read-back — parallel to `event-read-back.test.ts`
 * for `transcript.jsonl`/`RunEvent`, because `audit.jsonl`/`AuditEvent` is a
 * SEPARATE file on the SAME append-then-crash failure mode.
 */

const LOG = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	child: vi.fn(() => LOG),
}

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
})

async function baseDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-audit-'))
	dirs.push(dir)
	return dir
}

const auditEvent = (seq: number): AuditEvent => ({
	id: `aud_${seq}` as AuditEvent['id'],
	runId: '37ddff8e-e13f-4e57-937f-d048fa323f5e' as AuditEvent['runId'],
	seq,
	timestamp: seq,
	who: {
		agentId: 'agent_1',
		tenantId: 'c86e2f3d-70cf-4214-bf9c-7bf9a6f8b59b' as AuditEvent['who']['tenantId'],
	},
	what: { action: 'tool_call', tool: 'bash' },
	outcome: 'refused',
	cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
})

async function backends(): Promise<[string, RunStore][]> {
	const disk = new RunDiskStore({ baseDir: await baseDir(), logger: LOG })
	await disk.initRun('37ddff8e-e13f-4e57-937f-d048fa323f5e')
	const memory = new InMemoryRunStore()
	await memory.initRun('37ddff8e-e13f-4e57-937f-d048fa323f5e')
	return [
		['disk', disk],
		['memory', memory],
	]
}

describe('the two backends answer the same for the audit trail', () => {
	it('gives back everything appended, oldest first', async () => {
		for (const [name, store] of await backends()) {
			for (const seq of [1, 2, 3]) await store.appendAuditEvent?.(auditEvent(seq))

			const events = await store.readAuditEvents?.()

			expect(
				events?.map((e) => e.seq),
				name,
			).toEqual([1, 2, 3])
			expect(
				events?.every((e) => e.outcome === 'refused'),
				name,
			).toBe(true)
		}
	})
})

describe('InMemoryRunStore — rebinding to a different run', () => {
	it('starts the audit trail empty rather than carrying the origin run’s entries', async () => {
		const store = new InMemoryRunStore()
		await store.initRun('90a466e2-f869-4a3c-b750-f2156342ff40')
		await store.appendAuditEvent(auditEvent(1))

		await store.initRun('fe818a89-6a50-4e51-8a91-5f108ad85280')
		const events = await store.readAuditEvents()

		expect(events).toEqual([])
	})
})

describe('an audit trail cut off mid-write', () => {
	it('loses the fragment and nothing after it', async () => {
		const dir = await baseDir()
		const runDir = join(dir, '69f32250-b3d2-4f37-bda2-c9a58c1228e2')
		const first = new RunDiskStore({ baseDir: dir, logger: LOG })
		await first.initRun('69f32250-b3d2-4f37-bda2-c9a58c1228e2')
		await first.appendAuditEvent(auditEvent(1))
		// The shape a hard kill during `appendFile` leaves: a line with no
		// newline on the end of it.
		await appendFile(join(runDir, 'audit.jsonl'), '{"id":"aud_partial', 'utf-8')

		// A different process picks the run up and appends the next entry.
		const second = new RunDiskStore({ baseDir: dir, logger: LOG })
		await second.initRun('69f32250-b3d2-4f37-bda2-c9a58c1228e2')
		await second.appendAuditEvent(auditEvent(3))

		const events = await second.readAuditEvents()

		// Without the heal in `initRun` the fragment and the WHOLE, correct
		// entry 3 merge into one unparsable line, and 3 is skipped: the caller
		// awaited a durable write and it is gone.
		expect(events.map((e) => e.seq)).toEqual([1, 3])
	})

	it('does not touch an audit trail that ends properly', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('33feff5e-98bc-4395-bc16-c06999204246')
		await store.appendAuditEvent(auditEvent(1))
		const before = await readFile(
			join(dir, '33feff5e-98bc-4395-bc16-c06999204246', 'audit.jsonl'),
			'utf-8',
		)

		await new RunDiskStore({ baseDir: dir, logger: LOG }).initRun(
			'33feff5e-98bc-4395-bc16-c06999204246',
		)

		expect(
			await readFile(join(dir, '33feff5e-98bc-4395-bc16-c06999204246', 'audit.jsonl'), 'utf-8'),
		).toBe(before)
	})
})

describe('a run directory with no audit.jsonl', () => {
	it('answers empty rather than throwing', async () => {
		const dir = await baseDir()
		const store = new RunDiskStore({ baseDir: dir, logger: LOG })
		await store.initRun('0096ad94-be49-4e0a-aaa2-35d846e15698')

		expect(await store.readAuditEvents()).toEqual([])
	})
})
