/**
 * `drainParkedTurns` across REAL processes.
 *
 * A drain loop tested inside one process proves nothing about a lease: the
 * event loop serializes the two drainers, so "each turn exactly once" holds
 * against an implementation with no exclusion in it at all. What is under
 * test here is the composition — take, work, release, and the fence that
 * every record carries — arbitrated by nothing but the directory the
 * contenders share.
 *
 * Runs against `dist`, deliberately: separate node processes with no loader,
 * importing the built session log and the built loop, exactly as a host would.
 *
 * **`.proc-test.ts`, not `.test.ts`, and that is the point of the suffix.**
 * `vitest.proc.config.ts` exists because a spawning test competes for CPU
 * hard enough to flake the timing-sensitive tests running beside it. This
 * file spawns up to three node processes and sits out a real lease, so it
 * belongs in that suite; CI runs it as `pnpm --filter @namzu/sdk test:proc`,
 * which builds first, so the `dist` this depends on is there.
 */

import { execFile, spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDirAsync } from '../../__fixtures__/temp-dir.js'
import { SessionPaths } from '../../session/paths.js'
import {
	DiskSessionLog,
	type SessionLease,
	StaleSessionLeaseError,
} from '../../store/session-log/index.js'
import type { ProjectId, SessionId, TenantId, TopicId, TurnId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import {
	generateCheckpointId,
	generateMessageId,
	generateSessionId,
	generateTurnId,
} from '../../utils/id.js'

const exec = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const dist = join(here, '..', '..', '..', 'dist')
const worker = join(here, 'drain-worker.mjs')

const TENANT = '988097f6-b538-4e9a-a5ec-d6bf9864204a' as TenantId
const PROJECT = 'baa3f1b2-7a3d-4291-ba2e-694e4b02352b' as ProjectId
const TOPIC = '5b2340e7-1a7e-45e3-97bd-c297d5334dd9' as TopicId
const SLUG = 'drain'

interface WorkerLine {
	readonly holder: string
	readonly listed: number
	readonly drained: readonly string[]
	readonly skipped: readonly string[]
	readonly stale: readonly string[]
	readonly failed: readonly { turnId: string; error: string }[]
	readonly unreleased: readonly { turnId: string; error: string }[]
	readonly probes: readonly { turnId: string; fencedOut: boolean }[]
}

let root: string
let home: string
let paths: SessionPaths

function workerArgs(holder: string, ttlMs: number, mode: 'drain' | 'hang'): string[] {
	return [worker, dist, home, SLUG, TENANT, holder, String(ttlMs), mode]
}

/** Spawn one drainer to completion and read its report. */
async function drainer(holder: string, opts: { ttlMs?: number; barrier?: string } = {}) {
	const args = workerArgs(holder, opts.ttlMs ?? 60_000, 'drain')
	if (opts.barrier) args.push(opts.barrier)
	const { stdout } = await exec(process.execPath, args)
	return JSON.parse(stdout.trim()) as WorkerLine
}

/** A session in the shared home. */
interface Seeded {
	readonly sessionId: SessionId
	readonly turnId: TurnId
}

function logOf(sessionId: SessionId): DiskSessionLog {
	return DiskSessionLog.at(paths, { sessionId })
}

/**
 * One session per turn, each paused on a tool review: started, a prompt, a
 * committed checkpoint, the park, `turn_paused`, and the lease given back —
 * what a process that parked and exited leaves on disk.
 */
async function seed(count: number): Promise<Seeded[]> {
	const seeded: Seeded[] = []
	for (let i = 0; i < count; i++) {
		const sessionId = generateSessionId()
		const turnId = generateTurnId()
		const log = logOf(sessionId)
		const lease = (await log.claim({ holder: 'seed', ttlMs: 60_000 })) as SessionLease
		await log.append(lease, {
			type: 'session_started',
			projectId: PROJECT,
			tenantId: TENANT,
			topicId: TOPIC,
			cwd: root,
			agent: { id: 'agent', name: 'Agent' },
		})
		const userMessageId = generateMessageId()
		await log.beginTurn(lease, {
			turnId,
			userMessageId,
			config: { model: 'mock-model', tokenBudget: 0, timeoutMs: 0 },
		})
		const prompt = await log.append(lease, {
			type: 'message',
			turnId,
			messageId: userMessageId,
			role: 'user',
			content: createUserMessage('deploy it'),
		})
		// The drain reads only the record; no document stands behind it.
		const checkpointId = generateCheckpointId()
		await log.append(lease, {
			type: 'checkpoint_written',
			turnId,
			checkpointId,
			iteration: 1,
			throughSeq: prompt.pointer.seq,
			throughSha256: prompt.pointer.sha256,
			path: `checkpoints/${checkpointId}.json`,
			docSha256: 'b'.repeat(64),
		})
		await log.append(lease, {
			type: 'decision_requested',
			turnId,
			decisionId: checkpointId,
			checkpointId,
			request: {
				type: 'tool_review',
				sessionId,
				turnId,
				checkpointId,
				toolCalls: [{ id: 't1', name: 'deploy', input: {}, isDestructive: true }],
			} as never,
		})
		await log.append(lease, {
			type: 'turn_paused',
			turnId,
			checkpointId,
			reason: 'awaiting tool review',
		})
		await log.release(lease)
		seeded.push({ sessionId, turnId })
	}
	return seeded
}

/** Worker attribution is message content; the record's `gen` is the fence it was accepted under. */
interface Marker {
	readonly kind: 'done' | 'started' | 'probe'
	readonly holder: string
	readonly fence: number
	readonly gen: number
}

/** Every worker marker a session accumulated, oldest first. */
async function workMarkers(sessionId: SessionId): Promise<Marker[]> {
	const { entries } = await logOf(sessionId).readAll()
	return entries.flatMap(({ record }) => {
		if (record.type !== 'message' || record.role !== 'assistant') return []
		const content = (record.content as { content?: unknown }).content
		if (typeof content !== 'string') return []
		const payload = JSON.parse(content) as Record<string, unknown>
		if (payload.marker !== 'drain-worker') return []
		if (
			!['done', 'started', 'probe'].includes(String(payload.kind)) ||
			typeof payload.holder !== 'string' ||
			typeof payload.fence !== 'number'
		) {
			throw new Error('Malformed drain worker attribution')
		}
		return [
			{
				kind: payload.kind as Marker['kind'],
				holder: payload.holder,
				fence: payload.fence,
				gen: record.gen,
			},
		]
	})
}

async function lastRecordType(sessionId: SessionId): Promise<string | undefined> {
	return (await logOf(sessionId).readAll()).entries.at(-1)?.record.type
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'namzu-drain-'))
	home = join(root, 'home')
	paths = new SessionPaths({ home, slug: SLUG })
})

afterEach(async () => {
	await removeTempDirAsync(root)
})

describe('two drainer processes over one queue', () => {
	it('resumes each parked turn exactly once, under the fence of whoever took it', async () => {
		const seeded = await seed(3)
		const turnIds = seeded.map((s) => s.turnId)

		// A barrier past node's startup so the two actually contend. Startup
		// varies by tens of milliseconds, which is easily enough for one
		// drainer to empty the queue before the other begins — and contenders
		// that never overlap are not contending.
		const at = String(Date.now() + 1_500)
		const lines = await Promise.all(['w0', 'w1'].map((h) => drainer(h, { barrier: at })))
		const drained = lines.flatMap((l) => l.drained)

		// Exactly once IN TOTAL. Two drainers that both took a turn would both
		// resume it and both write under one turn id — and a listing would
		// look healthy afterwards. A released turn goes back to the index the
		// other drainer listed, so only re-reading the turn under the lease
		// keeps the second drainer off it; that is what `stale` is.
		expect([...drained].sort()).toEqual([...turnIds].sort())
		expect(lines.flatMap((l) => l.failed)).toEqual([])
		expect(lines.flatMap((l) => l.unreleased)).toEqual([])
		// Every row one drainer saw and the other had already done is accounted
		// for as contention, not as work.
		expect(
			lines.flatMap((l) => [...l.drained, ...l.skipped, ...l.stale]).length,
		).toBeGreaterThanOrEqual(turnIds.length)

		// And the durable record agrees with the report. A drainer could report
		// a turn it never wrote for; the log is the only witness that matters.
		for (const { sessionId, turnId } of seeded) {
			const markers = await workMarkers(sessionId)
			expect(markers).toHaveLength(1)
			const [marker] = markers as [Marker]
			expect(lines.find((l) => l.holder === marker.holder)?.drained).toContain(turnId)
			// Written under the drain's own holding, which superseded the seed's.
			expect(marker.gen).toBe(marker.fence)
			expect(marker.fence).toBeGreaterThan(1)
			expect(await lastRecordType(sessionId)).toBe('turn_completed')
		}

		// Every drainer's deliberately superseded write was refused, and left
		// nothing behind. This is the fence being ENFORCED during an ordinary
		// drain, rather than only in the dead-holder case below.
		const probes = lines.flatMap((l) => l.probes)
		expect(probes).toHaveLength(turnIds.length)
		expect(probes.every((p) => p.fencedOut)).toBe(true)
		for (const { sessionId } of seeded) {
			expect((await workMarkers(sessionId)).some((m) => m.kind === 'probe')).toBe(false)
		}
	}, 60_000)

	it('does not re-do a turn the other drainer already finished', async () => {
		const seeded = await seed(3)

		// STAGGERED, not simultaneous: one drainer lists AFTER the other
		// finished and released. Running them in sequence makes that order
		// certain instead of leaving it to how fast the disk was that day.
		const first = await drainer('w_first')
		expect([...first.drained].sort()).toEqual(seeded.map((s) => s.turnId).sort())

		const second = await drainer('w_second')

		// Nothing left for it: doing the work answered each park and settled
		// each turn, so none matches the filter any more.
		expect(second.drained).toEqual([])
		expect(second.failed).toEqual([])
		for (const { sessionId } of seeded) {
			expect(await workMarkers(sessionId)).toHaveLength(1)
		}
	}, 60_000)
})

describe('a drainer that dies holding a lease', () => {
	it('hands the turn to the next drainer once the lease lapses, and fences the corpse out', async () => {
		const [only] = (await seed(1)) as [Seeded]

		// Short enough that the test does not sit out a real lease, long enough
		// that the first drainer genuinely holds it while it is killed.
		const TTL_MS = 2_000

		const held = await new Promise<{ holding: string; lease: SessionLease }>((resolve, reject) => {
			const child = spawn(process.execPath, workerArgs('w_dead', TTL_MS, 'hang'))
			let buf = ''
			child.stdout.on('data', (d: Buffer) => {
				buf += d.toString()
				const line = buf.split('\n')[0]
				if (!line || !buf.includes('\n')) return
				// It has claimed and written; killing it now is a worker that dies
				// mid-turn rather than one that never started.
				child.kill('SIGKILL')
				resolve(JSON.parse(line) as { holding: string; lease: SessionLease })
			})
			child.on('error', reject)
			child.on('exit', (code, signal) => {
				if (buf.trim().length === 0) reject(new Error(`worker exited ${code} ${signal}`))
			})
		})

		expect(held.holding).toBe(only.turnId)
		// The session is now held by a process that no longer exists. Nothing
		// notifies the log; only the expiry makes it recoverable.
		expect(await workMarkers(only.sessionId)).toMatchObject([
			{ kind: 'started', holder: 'w_dead', fence: held.lease.fence },
		])

		await new Promise((r) => setTimeout(r, TTL_MS + 300))

		const second = JSON.parse(
			(await exec(process.execPath, workerArgs('w_live', 60_000, 'drain'))).stdout.trim(),
		) as WorkerLine

		expect(second.drained).toEqual([only.turnId])
		const markers = await workMarkers(only.sessionId)
		expect(markers).toHaveLength(2)
		const takeover = markers.find((m) => m.kind === 'done') as Marker
		// Strictly greater. A reclaim that reused the number would fence nobody
		// out, and the dead holder's write below would be accepted beside the
		// live one.
		expect(takeover.fence).toBeGreaterThan(held.lease.fence)

		// The corpse wakes up. From inside, a long pause, a suspended container
		// and a partition all look like time not passing, so it believes it
		// still holds the session — and the only moment it can learn otherwise
		// is the write.
		await expect(
			logOf(only.sessionId).append(held.lease, {
				type: 'message',
				turnId: only.turnId,
				messageId: generateMessageId(),
				role: 'assistant',
				content: {
					role: 'assistant',
					content: JSON.stringify({
						marker: 'drain-worker',
						kind: 'done',
						holder: 'w_dead',
						fence: held.lease.fence,
					}),
				} as never,
			}),
		).rejects.toBeInstanceOf(StaleSessionLeaseError)
		// And it wrote nothing: a refusal that still landed a record would be
		// the silent divergence the fence exists to prevent.
		expect(await workMarkers(only.sessionId)).toHaveLength(2)
	}, 60_000)
})
