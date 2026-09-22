import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { SessionId } from '../../../types/ids/index.js'
import {
	generateMessageId,
	generateProjectId,
	generateSessionId,
	generateTurnId,
} from '../../../utils/id.js'
import type { SessionRecordDraft } from '../core.js'
import { DiskSessionLog } from '../disk.js'
import { SessionLeasesReleasedError, releaseHeldSessionLeases } from '../held-leases.js'
import {
	DiskSessionLeaseStore,
	StaleSessionLeaseError,
	isLeaseLive,
	readSessionLease,
} from '../lease.js'

/**
 * A process told to stop (SIGTERM, SIGHUP) gives its session leases back
 * before it exits, so the session is not blocked for the rest of the lease's
 * time-to-live by a writer that no longer exists.
 *
 * One file, one test: releasing is process-wide and refuses every later claim
 * in this process, and vitest gives each file its own module state.
 */

const made: string[] = []
afterAll(async () => {
	await removeTempDirs(made.splice(0))
})

const CONFIG = { model: 'm', tokenBudget: 10_000, timeoutMs: 60_000 }

function open(root: string, sessionId: SessionId): DiskSessionLog {
	return new DiskSessionLog({
		sessionId,
		file: join(root, `${sessionId}.jsonl`),
		sessionDir: join(root, sessionId),
	})
}

describe('releaseHeldSessionLeases', () => {
	it('frees every session this process holds, leaves a running turn interrupted, and takes no lease after', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'namzu-held-leases-')))
		made.push(root)
		const sessionId = generateSessionId()
		const idle = generateSessionId()

		// This process: a running turn under a five-minute lease, and a second
		// session held between writes.
		const writer = open(root, sessionId)
		const lease = await writer.claim({ holder: `test:${process.pid}`, ttlMs: 5 * 60_000 })
		if (lease === null) throw new Error('claim failed')
		await writer.append(lease, {
			type: 'session_started',
			projectId: generateProjectId(),
			cwd: '/w',
			agent: { id: 'a', name: 'A' },
		} as SessionRecordDraft)
		const turnId = generateTurnId()
		await writer.beginTurn(lease, { turnId, userMessageId: generateMessageId(), config: CONFIG })
		const other = open(root, idle)
		expect(await other.claim({ holder: `test:${process.pid}:idle`, ttlMs: 5 * 60_000 })).not.toBe(
			null,
		)

		// Another writer (a fresh instance: what a restarted process opens) is refused.
		expect(await open(root, sessionId).claim({ holder: 'next', ttlMs: 60_000 })).toBe(null)
		expect((await open(root, sessionId).activeTurn())?.state).toBe('running')

		const result = await releaseHeldSessionLeases({ timeoutMs: 2_000 })
		expect(result).toEqual({ released: 2, unfinished: 0 })

		// The turn reads as interrupted: no live lease, not paused. Nothing was
		// appended for it. The next process's claim (its lease store: this
		// process refuses claims from now on) gets both sessions at once.
		const next = open(root, sessionId)
		expect((await next.activeTurn())?.state).toBe('interrupted')
		for (const id of [sessionId, idle]) {
			expect(isLeaseLive(await readSessionLease(join(root, id)), Date.now())).toBe(false)
			expect(
				await new DiskSessionLeaseStore(join(root, id)).claim({ holder: 'next', ttlMs: 60_000 }),
			).not.toBe(null)
		}
		const records = (await next.readAll()).entries.map((entry) => entry.record.type)
		expect(records).toEqual(['session_started', 'turn_started'])

		// The released holding writes nothing more, and this process claims nothing new.
		await expect(
			writer.append(lease, {
				type: 'message',
				turnId,
				messageId: generateMessageId(),
				role: 'assistant',
				content: { role: 'assistant', content: 'late' },
			} as SessionRecordDraft),
		).rejects.toBeInstanceOf(StaleSessionLeaseError)
		await expect(
			open(root, generateSessionId()).claim({ holder: 'after', ttlMs: 60_000 }),
		).rejects.toBeInstanceOf(SessionLeasesReleasedError)

		// A second call has nothing left to release.
		expect(await releaseHeldSessionLeases()).toEqual({ released: 0, unfinished: 0 })
	})
})
