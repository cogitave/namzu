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
		{ projectId: project.id, currentActor: userActor(tenantId) },
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
			{ projectId: project.id, currentActor: agentActor(tenantA) },
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
			{ projectId: project.id, currentActor: agentActor(tenantA) },
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
})

// Import after use so tests are self-contained w.r.t. types we already use.
import type { SessionId } from '../../../types/ids/index.js'
