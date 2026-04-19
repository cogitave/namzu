import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TenantIsolationError } from '../../../session/errors.js'
import type { ActorRef } from '../../../session/hierarchy/actor.js'
import type { AgentId, TenantId, UserId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { DiskSessionStore } from '../disk.js'

const tenantA = 'tnt_alpha' as TenantId
const tenantB = 'tnt_beta' as TenantId

function userActor(tenantId: TenantId): ActorRef {
	return { kind: 'user', userId: 'usr_a' as UserId, tenantId }
}

function agentActor(tenantId: TenantId): ActorRef {
	return { kind: 'agent', agentId: 'agt_a' as AgentId, tenantId }
}

async function seed(store: DiskSessionStore, tenantId: TenantId) {
	const project = await store.createProject({ tenantId, name: 'p1' }, tenantId)
	const session = await store.createSession(
		{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor(tenantId) },
		tenantId,
	)
	return { project, session }
}

describe('DiskSessionStore', () => {
	let rootDir: string
	let store: DiskSessionStore

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), 'namzu-session-disk-'))
		store = new DiskSessionStore({ rootDir })
	})

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true })
	})

	it('writes the canonical directory layout (projects/.../sessions/.../subsessions)', async () => {
		const { project, session } = await seed(store, tenantA)
		const child = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		const sub = await store.createSubSession(
			{
				parentSessionId: session.id,
				childSessionId: child.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		const projectJson = join(rootDir, 'projects', project.id, 'project.json')
		const sessionJson = join(
			rootDir,
			'projects',
			project.id,
			'sessions',
			session.id,
			'session.json',
		)
		const subJson = join(
			rootDir,
			'projects',
			project.id,
			'sessions',
			session.id,
			'subsessions',
			sub.id,
			'subsession.json',
		)
		expect(JSON.parse(await readFile(projectJson, 'utf-8')).id).toBe(project.id)
		expect(JSON.parse(await readFile(sessionJson, 'utf-8')).id).toBe(session.id)
		expect(JSON.parse(await readFile(subJson, 'utf-8')).id).toBe(sub.id)
	})

	it('round-trips a session across store instances (cold read)', async () => {
		const { project, session } = await seed(store, tenantA)

		// Construct a fresh store against the same rootDir — must find the session.
		const fresh = new DiskSessionStore({ rootDir })
		const reloaded = await fresh.getSession(session.id, tenantA)
		expect(reloaded).not.toBeNull()
		expect(reloaded?.id).toBe(session.id)
		expect(reloaded?.projectId).toBe(project.id)
		expect(reloaded?.currentActor?.kind).toBe('user')
	})

	it('writes are atomic: no *.tmp file remains after mutation', async () => {
		const { project, session } = await seed(store, tenantA)
		await store.updateSession({ ...session, status: 'active' }, tenantA)

		// Recursively list everything under rootDir and ensure no lingering .tmp
		async function walk(dir: string, out: string[]): Promise<void> {
			for (const entry of await readdir(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name)
				out.push(path)
				if (entry.isDirectory()) await walk(path, out)
			}
		}
		const files: string[] = []
		await walk(rootDir, files)
		expect(files.some((p) => p.endsWith('.tmp'))).toBe(false)
		expect(files).toContain(
			join(rootDir, 'projects', project.id, 'sessions', session.id, 'session.json'),
		)
	})

	it('rejects cross-tenant reads of persisted sessions', async () => {
		const { session } = await seed(store, tenantA)
		await expect(store.getSession(session.id, tenantB)).rejects.toBeInstanceOf(TenantIsolationError)
	})

	it('appendMessage + loadMessages round-trips via messages.jsonl', async () => {
		const { project, session } = await seed(store, tenantA)
		await store.appendMessage(session.id, createUserMessage('hello'), tenantA)
		await store.appendMessage(session.id, createUserMessage('world'), tenantA)

		const loaded = await store.loadMessages(session.id, tenantA)
		expect(loaded.map((m) => m.content)).toEqual(['hello', 'world'])

		const jsonl = await readFile(
			join(rootDir, 'projects', project.id, 'sessions', session.id, 'messages.jsonl'),
			'utf-8',
		)
		const lines = jsonl.split('\n').filter((l) => l.length > 0)
		expect(lines).toHaveLength(2)
	})

	it('loadMessages returns [] when no messages yet persisted', async () => {
		const { session } = await seed(store, tenantA)
		expect(await store.loadMessages(session.id, tenantA)).toEqual([])
	})

	it('drill returns children and ancestry after a cold reload', async () => {
		const { project, session: root } = await seed(store, tenantA)
		const child = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		await store.createSubSession(
			{
				parentSessionId: root.id,
				childSessionId: child.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		const fresh = new DiskSessionStore({ rootDir })
		const rootView = await fresh.drill(root.id, tenantA)
		expect(rootView?.children.map((c) => c.childSessionId)).toEqual([child.id])

		const childView = await fresh.drill(child.id, tenantA)
		expect(childView?.ancestry).toEqual([root.id, child.id])
	})

	it('missing session returns null rather than throwing', async () => {
		const fresh = new DiskSessionStore({ rootDir })
		expect(await fresh.getSession('ses_missing' as SessionId, tenantA)).toBeNull()
	})

	// Summary (§4.7 / §8.1) ---------------------------------------------------

	it('recordSummary persists summary.json and flips session status atomically', async () => {
		const { project, session } = await seed(store, tenantA)
		await store.updateSession({ ...session, status: 'active' }, tenantA)

		const summary: SessionSummaryRef & { materializedBy: 'kernel' } = {
			id: 'sum_disk1' as SummaryId,
			sessionRef: session.id,
			tenantId: tenantA,
			outcome: { status: 'succeeded' },
			deliverables: [],
			agentSummary: 'done',
			keyDecisions: [],
			at: new Date('2026-04-17T00:00:00Z'),
			materializedBy: 'kernel',
		}
		await store.recordSummary(summary, tenantA)

		const summaryJson = join(
			rootDir,
			'projects',
			project.id,
			'sessions',
			session.id,
			'summary.json',
		)
		const rawSummary = JSON.parse(await readFile(summaryJson, 'utf-8'))
		expect(rawSummary.id).toBe('sum_disk1')
		expect(rawSummary.materializedBy).toBe('kernel')

		const reloadedSession = await store.getSession(session.id, tenantA)
		expect(reloadedSession?.status).toBe('idle')
	})

	it('recordSummary is idempotent when replaying the same summary (recovery)', async () => {
		const { session } = await seed(store, tenantA)
		await store.updateSession({ ...session, status: 'active' }, tenantA)

		const summary: SessionSummaryRef & { materializedBy: 'kernel' } = {
			id: 'sum_disk2' as SummaryId,
			sessionRef: session.id,
			tenantId: tenantA,
			outcome: { status: 'succeeded' },
			deliverables: [],
			agentSummary: '',
			keyDecisions: [],
			at: new Date('2026-04-17T00:00:00Z'),
			materializedBy: 'kernel',
		}
		await store.recordSummary(summary, tenantA)

		// Force session back to active (simulating a crash mid-flip).
		const mid = await store.getSession(session.id, tenantA)
		if (!mid) throw new Error('mid session missing')
		await store.updateSession({ ...mid, status: 'active' }, tenantA)

		// Replay with the same summary — no throw, status flips again.
		await store.recordSummary(summary, tenantA)
		const after = await store.getSession(session.id, tenantA)
		expect(after?.status).toBe('idle')
	})

	it('recordSummary rejects a different summary for an already-summarized session', async () => {
		const { session } = await seed(store, tenantA)
		const first: SessionSummaryRef & { materializedBy: 'kernel' } = {
			id: 'sum_disk3a' as SummaryId,
			sessionRef: session.id,
			tenantId: tenantA,
			outcome: { status: 'succeeded' },
			deliverables: [],
			agentSummary: '',
			keyDecisions: [],
			at: new Date(),
			materializedBy: 'kernel',
		}
		await store.recordSummary(first, tenantA)

		const second = { ...first, id: 'sum_disk3b' as SummaryId }
		await expect(store.recordSummary(second, tenantA)).rejects.toMatchObject({
			name: 'SessionAlreadySummarizedError',
		})
	})

	it('deleteSession removes the session directory recursively', async () => {
		const { project, session } = await seed(store, tenantA)
		await store.appendMessage(session.id, createUserMessage('hi'), tenantA)

		await store.deleteSession(session.id, tenantA)

		const sessionDir = join(rootDir, 'projects', project.id, 'sessions', session.id)
		// Directory should be gone.
		const sessionsDirListing = await readdir(join(rootDir, 'projects', project.id, 'sessions'))
		expect(sessionsDirListing).not.toContain(session.id)
		// Session read returns null.
		expect(await store.getSession(session.id, tenantA)).toBeNull()
		// Path sanity: no ghost file at the session path.
		void sessionDir
	})

	it('deleteSession tolerates missing session directory (idempotent)', async () => {
		await expect(
			store.deleteSession('ses_nonexistent' as SessionId, tenantA),
		).resolves.toBeUndefined()
	})

	it('deleteSession rejects if sub-sessions are still attached', async () => {
		const { project, session: root } = await seed(store, tenantA)
		const child = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		await store.createSubSession(
			{
				parentSessionId: root.id,
				childSessionId: child.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		await expect(store.deleteSession(root.id, tenantA)).rejects.toThrow(/attached sub-sessions/)
	})

	it('deleteSubSession removes the sub-session directory and is idempotent', async () => {
		const { project, session: root } = await seed(store, tenantA)
		const child = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: agentActor(tenantA) },
			tenantA,
		)
		const sub = await store.createSubSession(
			{
				parentSessionId: root.id,
				childSessionId: child.id,
				kind: 'agent_spawn',
				spawnedBy: userActor(tenantA),
			},
			tenantA,
		)

		await store.deleteSubSession(sub.id, tenantA)
		expect(await store.getSubSession(sub.id, tenantA)).toBeNull()

		const subsDir = join(rootDir, 'projects', project.id, 'sessions', root.id, 'subsessions')
		const listing = await readdir(subsDir).catch(() => [] as string[])
		expect(listing).not.toContain(sub.id)

		// Idempotent.
		await expect(store.deleteSubSession(sub.id, tenantA)).resolves.toBeUndefined()
	})

	it('getSummary rejects cross-tenant reads', async () => {
		const { session } = await seed(store, tenantA)
		const summary: SessionSummaryRef & { materializedBy: 'kernel' } = {
			id: 'sum_disk4' as SummaryId,
			sessionRef: session.id,
			tenantId: tenantA,
			outcome: { status: 'succeeded' },
			deliverables: [],
			agentSummary: '',
			keyDecisions: [],
			at: new Date(),
			materializedBy: 'kernel',
		}
		await store.recordSummary(summary, tenantA)

		await expect(store.getSummary(session.id, tenantB)).rejects.toBeInstanceOf(TenantIsolationError)
	})

	describe('listSessions(threadId, tenantId)', () => {
		const threadX = 'thd_x' as ThreadId
		const threadY = 'thd_y' as ThreadId

		it('returns [] when the projects root is empty', async () => {
			// Fresh temp root — no projects directory yet.
			expect(await store.listSessions(threadX, tenantA)).toEqual([])
		})

		it('filters by threadId and tenant; orders by createdAt ascending', async () => {
			const project = await store.createProject({ tenantId: tenantA, name: 'p' }, tenantA)

			const first = await store.createSession(
				{ threadId: threadX, projectId: project.id, currentActor: userActor(tenantA) },
				tenantA,
			)
			await new Promise((r) => setTimeout(r, 2))
			const second = await store.createSession(
				{ threadId: threadX, projectId: project.id, currentActor: userActor(tenantA) },
				tenantA,
			)
			// Same project, different thread — must not appear.
			await store.createSession(
				{ threadId: threadY, projectId: project.id, currentActor: userActor(tenantA) },
				tenantA,
			)

			const listed = await store.listSessions(threadX, tenantA)
			expect(listed.map((s) => s.id)).toEqual([first.id, second.id])
		})

		it('skips cross-tenant sessions even when threadId matches', async () => {
			const pA = await store.createProject({ tenantId: tenantA, name: 'pa' }, tenantA)
			const pB = await store.createProject({ tenantId: tenantB, name: 'pb' }, tenantB)

			const own = await store.createSession(
				{ threadId: threadX, projectId: pA.id, currentActor: userActor(tenantA) },
				tenantA,
			)
			await store.createSession(
				{ threadId: threadX, projectId: pB.id, currentActor: userActor(tenantB) },
				tenantB,
			)

			const listed = await store.listSessions(threadX, tenantA)
			expect(listed.map((s) => s.id)).toEqual([own.id])
		})
	})
})

import type { SessionSummaryRef } from '../../../session/summary/ref.js'
// Import after use so tests are self-contained w.r.t. types we already use.
import type { SessionId } from '../../../types/ids/index.js'
import type { SummaryId, ThreadId } from '../../../types/session/ids.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId
