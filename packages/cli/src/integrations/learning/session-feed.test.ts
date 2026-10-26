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
		expect(row?.evidence.reason).toContain('[email]')
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
		feed.observe({ kind: 'paused', turnId: TURN, reason: 'rate limited' })
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

	it('records one observation per turn and kind, however often it is offered', async () => {
		const { feed, reader } = setup()
		for (const name of ['bash', 'read', 'bash'])
			feed.observe({ kind: 'tool-end', turnId: TURN, toolName: name, isError: true, summary: 'x' })
		await feed.flush()
		expect(await reader().observations()).toHaveLength(1)
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

describe('helpers', () => {
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
