import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
	generateProjectId,
	generateScheduleRunId,
	generateSessionId,
	generateTenantId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
	archiveConversation,
	closeSessions,
	loadConversation,
	openConversationLog,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
import {
	DELIVERY_READ_LIMIT,
	type SourceConversationBinding,
	type SourceDelivery,
	deliverRunToSource,
	readSourceDeliveries,
	readSourceDeliveryPage,
} from '../delivery.js'
import type { ScheduleJob, ScheduleRunResult } from '../types.js'
import { type Sandbox, confirmedJob, sandbox } from './fixtures.js'

const boxes: Sandbox[] = []
afterEach(() => {
	for (const box of boxes.splice(0)) box.cleanup()
})

async function setup() {
	const box = sandbox()
	boxes.push(box)
	const sessions = await openSessions(box.project, { stateRoot: box.home })
	const sessionId = await startConversation(sessions)
	const source: SourceConversationBinding = {
		kind: 'source-conversation',
		sessionId,
		projectSlug: sessions.slug,
		projectId: sessions.projectId,
		tenantId: sessions.tenantId,
	}
	const job = confirmedJob(box, { delivery: source })
	const result: ScheduleRunResult = {
		v: 1,
		kind: 'schedule-run-result',
		jobId: job.id,
		runId: generateScheduleRunId(),
		status: 'completed',
		exitCode: 0,
		startedAt: '2026-09-30T08:00:00.000Z',
		endedAt: '2026-09-30T08:00:03.000Z',
		summary: 'Three dependencies need updates.',
	}
	return { box, sessions, source, job, result, sessionId }
}

describe('source conversation delivery', () => {
	it('publishes one durable result per run and leaves model history untouched', async () => {
		const { box, sessions, source, job, result, sessionId } = await setup()
		try {
			expect(await deliverRunToSource(box.paths, job, result)).toEqual({ kind: 'delivered' })
			expect(await deliverRunToSource(box.paths, job, result)).toEqual({
				kind: 'already-delivered',
			})
			expect(await readSourceDeliveries(box.paths, source)).toEqual([
				expect.objectContaining({
					source,
					jobId: job.id,
					runId: result.runId,
					status: 'completed',
					summary: 'Three dependencies need updates.',
				}),
			])
			expect(readdirSync(join(box.paths.root, 'deliveries', sessionId))).toHaveLength(1)
			expect(await loadConversation(sessions, sessionId)).toEqual([])
			await archiveConversation(sessions, sessionId)
			expect(await deliverRunToSource(box.paths, job, result)).toEqual({
				kind: 'already-delivered',
			})
		} finally {
			closeSessions(sessions)
		}
	})

	it('delivers a later terminal outcome separately from its parked result', async () => {
		const { box, sessions, source, job, result } = await setup()
		try {
			const parked: ScheduleRunResult = {
				...result,
				status: 'awaiting-approval',
				endedAt: '2026-09-30T08:00:01.000Z',
				summary: undefined,
				reason: 'Approve the requested write.',
			}
			expect((await deliverRunToSource(box.paths, job, parked)).kind).toBe('delivered')
			expect((await deliverRunToSource(box.paths, job, result)).kind).toBe('delivered')
			expect((await readSourceDeliveries(box.paths, source)).map((item) => item.status)).toEqual([
				'awaiting-approval',
				'completed',
			])
		} finally {
			closeSessions(sessions)
		}
	})

	it('pages every publication and includes an old run delivered after newer results', async () => {
		const { box, sessions, source, job, result } = await setup()
		try {
			const dir = join(box.paths.root, 'deliveries', source.sessionId)
			mkdirSync(dir, { recursive: true })
			for (let index = 0; index < DELIVERY_READ_LIMIT * 2 + 5; index++) {
				const entry: SourceDelivery = {
					v: 1,
					kind: 'schedule-source-delivery',
					source,
					jobId: job.id,
					jobName: job.name,
					runId: generateScheduleRunId(),
					status: 'completed',
					at: '2026-09-30T08:00:00.000Z',
					publishedOrder: index + 1,
					summary: `Result ${index}`,
				}
				const key = createHash('sha256')
					.update(JSON.stringify([entry.jobId, entry.runId, entry.status, entry.at]))
					.digest('hex')
				writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry))
			}
			let cursor: Awaited<ReturnType<typeof readSourceDeliveryPage>>['cursor']
			const seen: SourceDelivery[] = []
			for (let page = 0; page < 3; page++) {
				const next = await readSourceDeliveryPage(box.paths, source, cursor)
				seen.push(...next.entries)
				cursor = next.cursor
				expect(next.hasMore).toBe(page < 2)
			}
			expect(seen).toHaveLength(DELIVERY_READ_LIMIT * 2 + 5)
			expect(seen.map((entry) => entry.summary)).toEqual(
				Array.from({ length: DELIVERY_READ_LIMIT * 2 + 5 }, (_, index) => `Result ${index}`),
			)
			const delayed = await deliverRunToSource(box.paths, job, {
				...result,
				endedAt: '2025-01-01T08:00:00.000Z',
				summary: 'Delayed old run',
			})
			expect(delayed.kind).toBe('delivered')
			const next = await readSourceDeliveryPage(box.paths, source, cursor)
			expect(next.entries.map((entry) => entry.summary)).toEqual(['Delayed old run'])
			expect(next.entries[0]?.publishedOrder).toBeGreaterThan(DELIVERY_READ_LIMIT * 2 + 5)
			const latest = await readSourceDeliveries(box.paths, source)
			expect(latest).toHaveLength(DELIVERY_READ_LIMIT)
			expect(latest.at(-1)?.summary).toBe('Delayed old run')
		} finally {
			closeSessions(sessions)
		}
	})

	it('keeps a damaged older inbox file visible as an error without blocking new publication', async () => {
		const { box, sessions, source, job, result } = await setup()
		try {
			const dir = join(box.paths.root, 'deliveries', source.sessionId)
			mkdirSync(dir, { recursive: true })
			const damaged = join(dir, `${'0'.repeat(64)}.json`)
			writeFileSync(damaged, '{')
			expect((await deliverRunToSource(box.paths, job, result)).kind).toBe('delivered')
			expect(readdirSync(dir)).toHaveLength(2)
			expect(readFileSync(damaged, 'utf8')).toBe('{')
			await expect(readSourceDeliveryPage(box.paths, source)).rejects.toThrow(/not valid JSON/)
		} finally {
			closeSessions(sessions)
		}
	})

	it('accepts a legacy source log without tenant only for this installation and project', async () => {
		const { box, sessions, source, job, result } = await setup()
		try {
			const legacyId = generateSessionId()
			const log = openConversationLog(sessions, legacyId)
			const lease = await log.claim({ holder: 'legacy-source-test', ttlMs: 30_000 })
			if (!lease) throw new Error('legacy source lease was unavailable')
			try {
				await log.append(lease, {
					type: 'session_started',
					projectId: sessions.projectId,
					cwd: sessions.projectRoot,
					agent: { id: 'legacy-cli', name: 'Legacy CLI' },
				})
			} finally {
				await log.release(lease)
			}
			const legacySource = { ...source, sessionId: legacyId }
			const legacyJob = { ...job, delivery: legacySource }
			expect((await deliverRunToSource(box.paths, legacyJob, result)).kind).toBe('delivered')
			expect((await readSourceDeliveries(box.paths, legacySource))[0]?.summary).toBe(
				'Three dependencies need updates.',
			)
			const otherId = generateSessionId()
			const otherLog = openConversationLog(sessions, otherId)
			const otherLease = await otherLog.claim({ holder: 'other-tenant-test', ttlMs: 30_000 })
			if (!otherLease) throw new Error('other source lease was unavailable')
			try {
				await otherLog.append(otherLease, {
					type: 'session_started',
					projectId: sessions.projectId,
					tenantId: generateTenantId(),
					cwd: sessions.projectRoot,
					agent: { id: 'other-cli', name: 'Other CLI' },
				})
			} finally {
				await otherLog.release(otherLease)
			}
			expect(
				(
					await deliverRunToSource(
						box.paths,
						{ ...job, delivery: { ...source, sessionId: otherId } },
						{ ...result, runId: generateScheduleRunId() },
					)
				).kind,
			).toBe('rejected')
			expect(
				(
					await deliverRunToSource(
						box.paths,
						{ ...legacyJob, delivery: { ...legacySource, tenantId: generateTenantId() } },
						{ ...result, runId: generateScheduleRunId() },
					)
				).kind,
			).toBe('rejected')
		} finally {
			closeSessions(sessions)
		}
	})

	it('does not flood the source for a quiet poll', async () => {
		const { box, sessions, source, job, result } = await setup()
		try {
			expect(
				await deliverRunToSource(box.paths, job, {
					...result,
					summary: undefined,
					gateResult: { wake: false, contextChars: 0 },
				}),
			).toEqual({ kind: 'quiet' })
			expect(
				await deliverRunToSource(box.paths, job, {
					...result,
					summary: undefined,
				}),
			).toEqual({ kind: 'quiet' })
			expect(
				await deliverRunToSource(box.paths, job, {
					...result,
					scriptReport: { v: 1, state: 'quiet', nextState: 'seen issue 12' },
				}),
			).toEqual({ kind: 'quiet' })
			expect(await readSourceDeliveries(box.paths, source)).toEqual([])
		} finally {
			closeSessions(sessions)
		}
	})

	it('delivers an explicit changed script report even without a separate summary', async () => {
		const { box, sessions, source, job, result } = await setup()
		try {
			expect(
				(
					await deliverRunToSource(box.paths, job, {
						...result,
						summary: undefined,
						scriptReport: { v: 1, state: 'changed', summary: 'Issue 12 changed' },
					})
				).kind,
			).toBe('delivered')
			expect((await readSourceDeliveries(box.paths, source))[0]?.summary).toBe('Issue 12 changed')
		} finally {
			closeSessions(sessions)
		}
	})

	it('bounds and sanitizes untrusted result text', async () => {
		const { box, sessions, source, job, result } = await setup()
		try {
			expect(
				(
					await deliverRunToSource(box.paths, job, {
						...result,
						summary: `Report\u001b[31m\u202e ${'a'.repeat(2_000)}`,
						reason: `failure\u0007 ${'b'.repeat(1_000)}`,
					})
				).kind,
			).toBe('delivered')
			const [delivered] = await readSourceDeliveries(box.paths, source)
			expect(delivered?.summary).not.toContain('\u001b')
			expect(delivered?.summary).not.toContain('\u202e')
			expect([...(delivered?.summary ?? '')].length).toBeLessThanOrEqual(600)
			expect(delivered?.reason).not.toContain('\u0007')
			expect([...(delivered?.reason ?? '')].length).toBeLessThanOrEqual(300)
		} finally {
			closeSessions(sessions)
		}
	})

	it('returns retry while the source conversation is leased', async () => {
		const { box, sessions, job, result, sessionId } = await setup()
		const log = openConversationLog(sessions, sessionId)
		const lease = await log.claim({ holder: 'active-source-turn', ttlMs: 30_000 })
		expect(lease).not.toBeNull()
		try {
			expect((await deliverRunToSource(box.paths, job, result)).kind).toBe('retry')
		} finally {
			if (lease) await log.release(lease)
			closeSessions(sessions)
		}
		expect((await deliverRunToSource(box.paths, job, result)).kind).toBe('delivered')
	})

	it('rejects an archived, missing or mismatched source without creating an inbox', async () => {
		const { box, sessions, source, job, result, sessionId } = await setup()
		try {
			const mismatches: SourceConversationBinding[] = [
				{ ...source, sessionId: generateSessionId() },
				{ ...source, projectId: generateProjectId() },
				{ ...source, tenantId: generateTenantId() },
				{ ...source, projectSlug: 'different-project' },
			]
			for (const delivery of mismatches) {
				const changed = { ...job, delivery } satisfies ScheduleJob
				expect((await deliverRunToSource(box.paths, changed, result)).kind).toBe('rejected')
			}
			await archiveConversation(sessions, sessionId)
			expect((await deliverRunToSource(box.paths, job, result)).kind).toBe('rejected')
			await expect(readSourceDeliveries(box.paths, source)).rejects.toThrow(/archived/)
		} finally {
			closeSessions(sessions)
		}
		expect(readdirSync(box.paths.root)).not.toContain('deliveries')
	})

	it('rejects a missing source log without recreating it', async () => {
		const { box, sessions, job, result, sessionId } = await setup()
		const logFile = sessions.paths.sessionLog({ sessionId })
		closeSessions(sessions)
		unlinkSync(logFile)
		expect((await deliverRunToSource(box.paths, job, result)).kind).toBe('rejected')
		expect(readdirSync(sessions.paths.projectDir())).not.toContain(`${sessionId}.jsonl`)
	})
})
