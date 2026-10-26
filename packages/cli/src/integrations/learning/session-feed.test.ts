import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ProjectId,
	SessionPaths,
	SqliteLearningStore,
	type TenantId,
	generateProjectId,
	generateTenantId,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
	RETENTION_DAYS,
	createSessionLearningFeed,
	redactSummary,
	uuidTime,
	withSessionLearningFeed,
} from './session-feed.js'

const roots: string[] = []
afterEach(() => {
	for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const idAt = (ms: number, tail = '456789abcdef') =>
	`${ms
		.toString(16)
		.padStart(12, '0')
		.replace(/^(.{8})(.{4})$/, '$1-$2')}-7def-8123-${tail}`
// A conversation minted now, so retention (which reads the id's time) keeps it.
const SESSION = idAt(Date.now())
const TURN = idAt(Date.now(), '456789abcd01')

function setup(now?: () => number, sessionId = SESSION) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-feed-'))
	roots.push(home)
	const paths = new SessionPaths({ home, slug: 'proj' })
	const tenantId: TenantId = generateTenantId()
	const projectId: ProjectId = generateProjectId()
	const feed = createSessionLearningFeed({
		paths,
		tenantId,
		projectId,
		sessionId,
		...(now ? { now } : {}),
	})
	const reader = () =>
		new SqliteLearningStore({
			databasePath: join(paths.projectDir(), 'learning', 'learning.sqlite'),
			artifactsPath: join(paths.projectDir(), 'learning', 'artifacts'),
			scope: { tenantId, projectId, agentKey: 'sessions' },
			readOnly: true,
		})
	return { feed, reader, paths, home, tenantId, projectId }
}

describe('session learning feed', () => {
	it('keeps a failed tool call as a reference plus a short redacted sentence', async () => {
		const { feed, reader } = setup()
		feed.observe({
			kind: 'tool-end',
			turnId: TURN,
			toolName: 'bash',
			isError: true,
			summary:
				'cat /home/someone/secret.txt failed for a@b.com token abcdefghijklmnopqrstuvwxyz0123',
		})
		await feed.flush()
		const [row, ...rest] = await reader().observations()
		expect(rest).toEqual([])
		expect(row?.sessionId).toBe(SESSION)
		expect(row?.turnId).toBe(TURN)
		expect(row?.outcome).toBe('failed')
		expect(row?.usageComplete).toBe(false)
		expect(row?.evidence.reason).not.toMatch(/a@b\.com|abcdefghijklmnopqrstuvwxyz0123/)
		expect(row?.evidence.reason).toBe('A bash call failed. The message is not kept.')
	})

	it('never keeps a failure message, so a short bare secret cannot reach a reader', async () => {
		const { feed, reader } = setup()
		feed.observe({
			kind: 'tool-end',
			toolName: 'bash',
			isError: true,
			summary: 'wrong password hunter2',
			plainFailure: 'sk-abc123 rejected',
		})
		feed.observe({
			kind: 'error',
			message: 'bad credential hunter2',
			providerError: { code: 401 },
		})
		await feed.flush()
		const rows = await reader().observations()
		expect(rows).toHaveLength(2)
		for (const row of rows) expect(row.evidence.reason).not.toMatch(/hunter2|sk-abc123/)
		expect(rows.map((r) => r.evidence.reason)).toContain(
			'The provider failed (401). The message is not kept.',
		)
	})

	it("does not record the person's own choices or a plain pause as failures", async () => {
		const { feed, reader } = setup()
		for (const stopReason of ['cancelled', 'plan_rejected', 'stop_condition', 'paused']) {
			feed.observe({ kind: 'done', turnId: TURN, stopReason })
		}
		feed.observe({ kind: 'paused', turnId: TURN, reason: 'needs approval' })
		await feed.flush()
		expect(await reader().observations()).toEqual([])
	})

	it('records unrecovered stops, pauses and provider errors, and nothing for success', async () => {
		const { feed, reader } = setup()
		feed.observe({ kind: 'done', turnId: TURN, stopReason: 'end_turn' })
		feed.observe({
			kind: 'tool-end',
			toolName: 'read',
			isError: true,
			summary: 'no',
			declined: { note: 'no' },
		})
		feed.observe({ kind: 'done', turnId: TURN, stopReason: 'max_iterations' })
		feed.observe({
			kind: 'paused',
			turnId: TURN,
			reason: 'rate limited',
			providerError: { code: 429 },
		})
		feed.observe({ kind: 'error', message: 'upstream 503', providerError: { code: 503 } })
		feed.observe({ kind: 'delta' })
		await feed.flush()
		const rows = await reader().observations()
		expect(rows.map((r) => `${r.evaluatorRevision}:${r.outcome}`).sort()).toEqual([
			'provider-error-v1:execution-error',
			'turn-pause-v1:unresolved',
			'turn-stop-v1:unresolved',
		])
	})

	it('records the recoveries the conversation already classifies, with fixed wording', async () => {
		const { feed, reader } = setup()
		feed.observe({
			kind: 'provider-wait',
			turnId: TURN,
			code: 'rate_limit',
			attempt: 1,
			maxRetries: 3,
		})
		feed.observe({
			kind: 'provider-wait',
			turnId: TURN,
			code: 'rate_limit',
			attempt: 2,
			maxRetries: 3,
		})
		feed.observe({ kind: 'provider-fallback', text: 'Acme /home/x/secret moved to Other' } as never)
		feed.observe({
			kind: 'history-repair',
			duplicateResults: 1,
			orphanedResults: 0,
			interruptedCalls: 2,
			text: 'secret=abc',
		} as never)
		feed.observe({ kind: 'context', row: 'warning', shed: false, text: 'token=abc' } as never)
		// Compaction that worked, a hidden pass and an unchanged notice are not failures.
		feed.observe({ kind: 'context', row: 'compacted', shed: true })
		feed.observe({ kind: 'context', row: 'hidden', shed: true })
		await feed.flush()
		const rows = await reader().observations()
		expect(rows.map((r) => `${r.evaluatorRevision}:${r.outcome}`).sort()).toEqual([
			'compaction-failure-v1:unresolved',
			'history-repair-v1:unresolved',
			'provider-fallback-v1:unresolved',
			'provider-retry-v1:unresolved',
		])
		const text = JSON.stringify(rows)
		expect(text).not.toMatch(/Acme|secret|token=abc|\/home\/x/)
	})

	it('records one observation per turn and kind, however often it is offered', async () => {
		const { feed, reader } = setup()
		for (const name of ['bash', 'read', 'bash'])
			feed.observe({ kind: 'tool-end', turnId: TURN, toolName: name, isError: true, summary: 'x' })
		await feed.flush()
		expect(await reader().observations()).toHaveLength(1)
	})

	it('records an invalid-arguments failure once and not the read-first advice', async () => {
		const { feed, reader } = setup()
		feed.observe({
			kind: 'tool-end',
			turnId: TURN,
			toolName: 'edit',
			isError: true,
			summary: 'x',
			plainFailure: 'File must be read first',
			plainFailureTone: 'muted',
		})
		for (let i = 0; i < 2; i++)
			feed.observe({
				kind: 'tool-end',
				turnId: TURN,
				toolName: 'edit',
				isError: true,
				summary: 'x',
				plainFailure: 'Invalid parameters',
			})
		await feed.flush()
		const rows = await reader().observations()
		expect(rows).toHaveLength(1)
		expect(rows[0]?.evidence.reason).toBe('A edit call failed. The message is not kept.')
	})

	it('writes nothing until there is something to record', async () => {
		const { feed, paths } = setup()
		feed.observe({ kind: 'done', stopReason: 'end_turn' })
		await feed.flush()
		expect(() => readdirSync(join(paths.projectDir(), 'learning'))).toThrow()
	})

	it('drops observations of conversations older than the retention window', async () => {
		const day = 86_400_000
		const nowMs = Date.UTC(2026, 9, 26)
		const old = nowMs - (RETENTION_DAYS + 1) * day
		const { feed, reader, paths, tenantId, projectId } = setup(() => old, idAt(old))
		feed.observe({ kind: 'done', turnId: TURN, stopReason: 'timeout' })
		await feed.flush()
		expect(await reader().observations()).toHaveLength(1)
		// A conversation 31 days later opens the store again and prunes the old one.
		const next = createSessionLearningFeed({
			paths,
			tenantId,
			projectId,
			sessionId: idAt(nowMs),
			now: () => nowMs,
		})
		next.observe({ kind: 'done', turnId: TURN, stopReason: 'timeout' })
		await next.flush()
		const rows = await reader().observations()
		expect(rows.map((r) => r.sessionId)).toEqual([idAt(nowMs)])
	})
})

describe('retention for any session id', () => {
	it('prunes by the recorded time even when the id carries no clock', async () => {
		const day = 86_400_000
		const nowMs = Date.UTC(2026, 9, 26)
		const old = nowMs - (RETENTION_DAYS + 1) * day
		const plain = '3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f'
		const { feed, reader, paths, tenantId, projectId } = setup(() => old, plain)
		feed.observe({ kind: 'done', turnId: TURN, stopReason: 'timeout' })
		await feed.flush()
		expect(await reader().observations()).toHaveLength(1)
		const next = createSessionLearningFeed({
			paths,
			tenantId,
			projectId,
			sessionId: idAt(nowMs),
			now: () => nowMs,
		})
		next.observe({ kind: 'done', turnId: TURN, stopReason: 'timeout' })
		await next.flush()
		expect((await reader().observations()).map((r) => r.sessionId)).toEqual([idAt(nowMs)])
	})
})

describe('helpers', () => {
	it('masks key=value secrets, bearer credentials and absolute paths', () => {
		const text = redactSummary(
			'failed: password=hunter2 key: abc123 Bearer sk-1 at /etc/app/conf.json',
			'/home/x',
		)
		expect(text).not.toMatch(/hunter2|abc123|sk-1|\/etc/)
		expect(text).toContain('[path]')
	})
	it('masks drive-letter and network paths that are not under the home folder', () => {
		const text = redactSummary('open C:\\Users\\bob\\x.txt and \\\\srv\\share\\f failed', '/home/x')
		expect(text).toBe('open [path] and [path] failed')
	})
	it('reads the time out of a version-7 id only', () => {
		expect(uuidTime(idAt(1_700_000_000_000))).toBe(1_700_000_000_000)
		expect(uuidTime('3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f')).toBeNull()
	})
	it('shortens, strips control characters and masks homes, links and long tokens', () => {
		const text = redactSummary('fail\u0007now in /home/x/app see https://a.b/c?t=1', '/home/x')
		expect(text).toBe('fail now in ~/app see [link]')
		expect(redactSummary('y'.repeat(300)).length).toBeLessThanOrEqual(161)
	})
})

describe('withSessionLearningFeed', () => {
	it('passes every event through unchanged, offers each to the feed, and keeps getters live', async () => {
		const seen: unknown[] = []
		let live = 1
		const session = {
			get live() {
				return live
			},
			async *send() {
				yield { kind: 'delta', text: 'a' }
				yield { kind: 'done', stopReason: 'timeout' }
			},
			async *resumePaused() {
				yield { kind: 'error', message: 'boom' }
			},
		}
		const wrapped = withSessionLearningFeed(session, {
			observe: (event) => seen.push(event),
			flush: async () => {},
		})
		const sent: unknown[] = []
		for await (const e of wrapped.send()) sent.push(e)
		const resumed: unknown[] = []
		for await (const e of wrapped.resumePaused()) resumed.push(e)
		expect(sent).toEqual([
			{ kind: 'delta', text: 'a' },
			{ kind: 'done', stopReason: 'timeout' },
		])
		expect(resumed).toEqual([{ kind: 'error', message: 'boom' }])
		expect(seen).toHaveLength(3)
		live = 2
		expect(wrapped.live).toBe(2)
	})

	it('finishes writing before the session closes', async () => {
		const order: string[] = []
		const session = {
			async *send() {},
			async *resumePaused() {},
			close: async () => {
				order.push('close')
			},
		}
		const wrapped = withSessionLearningFeed(session, {
			observe: () => {},
			flush: async () => {
				order.push('flush')
			},
		})
		await wrapped.close()
		expect(order).toEqual(['flush', 'close'])
	})
})
