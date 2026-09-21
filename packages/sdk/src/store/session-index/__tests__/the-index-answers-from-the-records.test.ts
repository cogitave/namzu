import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ids } from '../../../__fixtures__/session-log/build.js'
import { fixtureUuid } from '../../../test-support/ids.js'
import type { SessionId } from '../../../types/ids/index.js'
import type { SessionIndex } from '../index.js'
import { ScanSessionIndex } from '../scan.js'
import { SqliteSessionIndex } from '../sqlite.js'
import { homeWithFixtures } from './support.js'

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

const sid = (name: string) => ids.session(name) as SessionId

const backends: { name: string; open(): Promise<SessionIndex> }[] = [
	{
		name: 'sqlite',
		open: () => SqliteSessionIndex.open({ home, path: join(root, 'index.sqlite') }),
	},
	{ name: 'scan', open: () => ScanSessionIndex.load(home) },
]

describe.each(backends)('$name', (backend) => {
	let index: SessionIndex
	beforeEach(async () => {
		index = await backend.open()
	})
	afterEach(() => index.close())

	it('lists sessions with their head, and child sessions under their root', async () => {
		const valid = await index.getSession(sid('valid'))
		expect(valid).toMatchObject({
			id: sid('valid'),
			slug: '-work-fixture',
			projectId: ids.project,
			rootId: sid('valid'),
			depth: 0,
			archived: false,
			status: 'idle',
			createdAt: '2026-09-21T09:00:01.000Z',
		})
		expect(valid?.parentId).toBeUndefined()
		expect(valid?.headSeq).toBe(24)
		expect(valid?.headSha256).toMatch(/^[a-f0-9]{64}$/)

		const child = await index.getSession(sid('child'))
		expect(child).toMatchObject({ parentId: sid('parent'), rootId: sid('parent'), depth: 1 })
		const roots = await index.listSessions({ rootsOnly: true })
		expect(roots.map((s) => s.id)).not.toContain(sid('child'))
		expect(roots.map((s) => s.id)).toContain(sid('parent'))
		expect(await index.listSessions({ slug: 'another-slug' })).toEqual([])
	})

	it('indexes only the intact prefix of a torn or broken log', async () => {
		// torn-tail: 9 whole records, then a cut line.
		expect((await index.getSession(sid('torn-tail')))?.headSeq).toBe(9)
		// broken-chain: record 4 names a wrong previous hash.
		expect((await index.getSession(sid('broken-chain')))?.headSeq).toBe(3)
	})

	it('lists turns with their settlement, preview and origin', async () => {
		const turns = await index.listTurns(sid('valid'))
		expect(turns).toEqual([
			{
				id: ids.turn('valid-1'),
				sessionId: sid('valid'),
				status: 'completed',
				stopReason: 'end_turn',
				startedAt: '2026-09-21T09:00:02.000Z',
				endedAt: expect.any(String),
				tokens: 150,
				costUsd: 0.002,
				userPreview: 'List the files.',
			},
			expect.objectContaining({ id: ids.turn('valid-2'), userPreview: 'Thanks.' }),
		])

		const abandoned = await index.listTurns(sid('abandoned'))
		expect(abandoned.map((t) => [t.status, t.tokens])).toEqual([
			['failed', 0],
			['failed', 0],
			['completed', 150],
		])

		const origin = await index.listTurns(sid('origin'))
		expect(origin[0]?.originKind).toBe('prompt')

		const torn = await index.listTurns(sid('torn-tail'))
		expect(torn.map((t) => t.status)).toEqual(['running'])
		expect((await index.getSession(sid('torn-tail')))?.status).toBe('running')
	})

	it('follows a turn through a pause and its resumption', async () => {
		const [turn] = await index.listTurns(sid('paused'))
		expect(turn?.status).toBe('completed')
		expect(await index.listPendingDecisions({ sessionId: sid('paused') })).toEqual([])
	})

	it('lists the children a parent log names, with the child row once its log is indexed', async () => {
		const children = await index.listChildren(sid('parent'))
		expect(children).toHaveLength(1)
		expect(children[0]).toMatchObject({
			sessionId: sid('child'),
			parentSessionId: sid('parent'),
			parentTurnId: ids.turn('parent-1'),
			toolCallId: 'toolu_fixture_task',
			kind: 'agent_spawn',
			description: 'Review the diff',
			path: `subagents/${sid('child')}.jsonl`,
			status: 'completed',
			stopReason: 'end_turn',
			tokens: 150,
		})
		expect(children[0]?.session?.id).toBe(sid('child'))
		expect(children[0]?.batch).toBeUndefined()
		expect(await index.listChildren(sid('valid'))).toEqual([])
	})

	it('derives batches from child_session_spawned.batch, including a child that outlives its turn', async () => {
		const batches = await index.batches()
		expect(batches).toEqual([
			{
				batchId: fixtureUuid('batch:1'),
				sessionId: sid('batch'),
				name: 'Package audit',
				phase: 'scan',
				agentsDone: 2,
				agentsTotal: 2,
				tokensTotal: 200,
			},
		])
		const children = await index.listChildren(sid('batch'))
		// In spawn order; b ended during the next turn, with no turnId.
		expect(children.map((c) => [c.sessionId, c.status, c.batch?.batchId])).toEqual([
			[sid('batch-child-a'), 'completed', fixtureUuid('batch:1')],
			[sid('batch-child-b'), 'completed', fixtureUuid('batch:1')],
		])
		expect(children.every((c) => c.session === undefined)).toBe(true)
	})

	it('resolves caller-side names, including one that is not a UUID', async () => {
		expect(await index.resolveExternal('ag-ui', 'thread', 'thread-7f')).toEqual({
			protocol: 'ag-ui',
			kind: 'thread',
			externalId: 'thread-7f',
			sessionId: sid('origin'),
		})
		expect(await index.resolveExternal('a2a', 'context', 'ctx not a uuid')).toEqual({
			protocol: 'a2a',
			kind: 'context',
			externalId: 'ctx not a uuid',
			sessionId: sid('origin'),
		})
		expect(await index.resolveExternal('ag-ui', 'turn', 'run-client-1')).toEqual({
			protocol: 'ag-ui',
			kind: 'turn',
			externalId: 'run-client-1',
			sessionId: sid('origin'),
			turnId: ids.turn('origin-1'),
		})
		// Added, then removed by a later session_updated.
		expect(await index.resolveExternal('desktop', 'session', 'desktop:42')).toBeUndefined()
		expect(await index.resolveExternal('a2a', 'thread', 'ctx not a uuid')).toBeUndefined()
		// Ordered by protocol, kind, then id.
		expect((await index.listExternalRefs(sid('origin'))).map((r) => r.externalId)).toEqual([
			'ctx not a uuid',
			'thread-7f',
			'run-client-1',
		])
		expect((await index.getSession(sid('origin')))?.title).toBe('Release checklist')
	})
})

describe('pending decisions', () => {
	it.each(backends)(
		'$name: a parked turn is listed until it is resolved or closed',
		async (backend) => {
			const index = await backend.open()
			try {
				// No fixture ends parked; cut the paused fixture right after its turn_paused.
				const logs = await index.listSessions()
				const paused = logs.find((s) => s.id === sid('paused'))
				if (paused === undefined) throw new Error('paused fixture missing')
				const full = readFileSync(paused.logPath, 'utf8')
				const lines = full.split(/(?<=\n)/)
				const parkedAt = lines.findIndex((line) => line.includes('"type":"turn_paused"'))
				writeFileSync(paused.logPath, lines.slice(0, parkedAt + 1).join(''))
				const location = { slug: paused.slug, logPath: paused.logPath, sessionId: paused.id }
				expect(await index.refresh(location)).toBe('truncated')
				expect(await index.listPendingDecisions()).toEqual([
					{
						decisionId: 'decision-1',
						sessionId: sid('paused'),
						turnId: ids.turn('paused-1'),
						checkpointId: ids.checkpoint('paused-1'),
						deadlineAt: '2026-09-21T10:00:00.000Z',
					},
				])
				expect((await index.getSession(sid('paused')))?.status).toBe('paused')
				expect((await index.listTurns(sid('paused')))[0]?.status).toBe('paused')

				appendFileSync(paused.logPath, lines.slice(parkedAt + 1, parkedAt + 2).join(''))
				expect(await index.refresh(location)).toBe('grown')
				expect(await index.listPendingDecisions()).toEqual([])
			} finally {
				index.close()
			}
		},
	)
})
