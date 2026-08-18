import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'

import type { ProjectId, SessionId, TenantId, TopicId, UserId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ActorRef } from '../../types/session/actor.js'
import {
	DiskSessionStore,
	migrateSessionStoreThreadIdToTopicId,
	migrateSessionStoreTopicIdPrefix,
} from '../session/disk.js'

/**
 * The primitive is unit-tested next door. What matters here is that a store
 * actually goes through it — a version that is stamped but never checked,
 * or checked but never stamped, is the same silent read it replaces.
 */

const TENANT = 'tnt_schema' as TenantId
const TOPIC = 'top_schema' as TopicId

const actor = (): ActorRef => ({ kind: 'user', userId: 'usr_a' as UserId, tenantId: TENANT })

let rootDir: string
let store: DiskSessionStore

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), 'namzu-schema-'))
	store = new DiskSessionStore({ rootDir })
})

afterEach(() => {
	removeTempDir(rootDir)
})

async function seed(): Promise<{ projectId: ProjectId; sessionId: SessionId }> {
	const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
	const session = await store.createSession(
		{ topicId: TOPIC, projectId: project.id, currentActor: actor() },
		TENANT,
	)
	return { projectId: project.id, sessionId: session.id }
}

const sessionPath = (projectId: ProjectId, sessionId: SessionId) =>
	join(rootDir, 'projects', projectId, 'sessions', sessionId, 'session.json')

describe('what lands on disk', () => {
	it('stamps a session record', async () => {
		const { projectId, sessionId } = await seed()
		const raw = JSON.parse(await readFile(sessionPath(projectId, sessionId), 'utf-8'))
		// v4 distinguishes ordinary message lines from replacement projection
		// records. The schema is shared by every session-store record, so a
		// session carries that current stamp even though its own shape is unchanged.
		expect(raw.schemaVersion).toBe(4)
	})

	it('stamps every line of the append-only message log', async () => {
		const { projectId, sessionId } = await seed()
		await store.appendMessage(sessionId, createUserMessage('one'), TENANT)
		await store.appendMessage(sessionId, createUserMessage('two'), TENANT)

		const log = await readFile(
			join(rootDir, 'projects', projectId, 'sessions', sessionId, 'messages.jsonl'),
			'utf-8',
		)
		const lines = log.split('\n').filter((l) => l.length > 0)
		expect(lines).toHaveLength(2)
		// An append-only log is written by many builds over its lifetime, so
		// its lines can legitimately differ in version — each carries its own.
		for (const line of lines) expect(JSON.parse(line).schemaVersion).toBe(4)
	})
})

describe('what comes back off disk', () => {
	it('reads a legacy record that predates the stamp', async () => {
		const { projectId, sessionId } = await seed()
		const path = sessionPath(projectId, sessionId)
		const record = JSON.parse(await readFile(path, 'utf-8'))
		record.schemaVersion = undefined
		await writeFile(path, JSON.stringify(record), 'utf-8')

		// Every file written before this mechanism existed looks exactly
		// like this, and has to keep opening.
		expect(await store.getSession(sessionId, TENANT)).not.toBeNull()
	})

	it('refuses a record from a build that knew more than this one', async () => {
		const { projectId, sessionId } = await seed()
		const path = sessionPath(projectId, sessionId)
		const record = JSON.parse(await readFile(path, 'utf-8'))
		record.schemaVersion = 99
		record.somethingThisBuildDoesNotKnow = { important: true }
		await writeFile(path, JSON.stringify(record), 'utf-8')

		// Reading it would drop the unknown field, and the next write would
		// destroy it. A refusal is recoverable by upgrading.
		await expect(store.getSession(sessionId, TENANT)).rejects.toThrow(/schema version 99/)
	})

	it('refuses a message line from the future rather than skipping it', async () => {
		const { projectId, sessionId } = await seed()
		await store.appendMessage(sessionId, createUserMessage('fine'), TENANT)

		const path = join(rootDir, 'projects', projectId, 'sessions', sessionId, 'messages.jsonl')
		const line = JSON.parse((await readFile(path, 'utf-8')).trim())
		await writeFile(path, `${JSON.stringify({ ...line, schemaVersion: 42 })}\n`, 'utf-8')

		// Silently dropping a message the build cannot read would hand the
		// model a conversation with a hole in it.
		await expect(store.loadMessages(sessionId, TENANT)).rejects.toThrow(/schema version 42/)
	})

	it('still round-trips a normal write and read', async () => {
		const { sessionId } = await seed()
		await store.appendMessage(sessionId, createUserMessage('hello'), TENANT)
		await store.appendMessage(sessionId, createUserMessage('world'), TENANT)

		const loaded = await store.loadMessages(sessionId, TENANT)
		expect(loaded.map((m) => m.content)).toEqual(['hello', 'world'])
	})
})

describe('threadId → topicId (NZ-TOPIC-03, v1→v2)', () => {
	it('migrates a pre-rename session.json: threadId becomes topicId, threadId is gone', async () => {
		const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
		const sessionId = 'ses_legacy' as SessionId
		const dir = join(rootDir, 'projects', project.id, 'sessions', sessionId)
		await mkdir(dir, { recursive: true })
		// Exactly what every session.json on a user's disk looks like before
		// NZ-TOPIC-03: unstamped (schemaVersion absent, so version 1 by
		// `store/schema.ts`'s own definition) and spelled `threadId`. Also
		// still `thd_`-valued, which is exactly what a real pre-TOPIC-03 file
		// would be (TOPIC-04's `top_` narrowing did not exist yet either) — so
		// this record legitimately chains through BOTH migration steps below.
		const legacy = {
			id: sessionId,
			threadId: 'thd_legacy',
			projectId: project.id,
			tenantId: TENANT,
			status: 'idle',
			currentActor: null,
			previousActors: [],
			workspaceId: null,
			ownerVersion: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
		await writeFile(join(dir, 'session.json'), JSON.stringify(legacy), 'utf-8')

		const loaded = await store.getSession(sessionId, TENANT)
		expect(loaded).not.toBeNull()
		// v1 chains straight through v1->v2 (rename) AND v2->v3 (top_ rewrite)
		// in the same migrate() call — a record this old was never `top_` and
		// must not still read back `thd_`.
		expect((loaded as unknown as { topicId?: unknown })?.topicId).toBe('top_legacy')
		// `deserializeSession` only ever reads `topicId` off the persisted
		// record now, so this is really asserting the migration ran at all.
		expect((loaded as unknown as { threadId?: unknown })?.threadId).toBeUndefined()
	})

	it('a legacy record survives a subsequent write at the current schema version', async () => {
		// The read-then-write path (updateSession) is how a record actually
		// gets upgraded on disk: migrate() only runs on read, so the v1 shape
		// persists until something writes the session back.
		const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
		const sessionId = 'ses_legacy2' as SessionId
		const dir = join(rootDir, 'projects', project.id, 'sessions', sessionId)
		await mkdir(dir, { recursive: true })
		const legacy = {
			id: sessionId,
			threadId: 'thd_legacy2',
			projectId: project.id,
			tenantId: TENANT,
			status: 'idle',
			currentActor: null,
			previousActors: [],
			workspaceId: null,
			ownerVersion: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}
		await writeFile(join(dir, 'session.json'), JSON.stringify(legacy), 'utf-8')

		const loaded = await store.getSession(sessionId, TENANT)
		if (!loaded) throw new Error('session missing')
		await store.updateSession({ ...loaded, status: 'active' }, TENANT)

		const rewritten = JSON.parse(await readFile(join(dir, 'session.json'), 'utf-8'))
		expect(rewritten.schemaVersion).toBe(4)
		expect(rewritten.topicId).toBe('top_legacy2')
		expect(rewritten.threadId).toBeUndefined()
	})

	it('migrateSessionStoreThreadIdToTopicId leaves a record with no threadId untouched', () => {
		// The shared migration runs over every kind `session-store` stamps —
		// project.json, session.json, subsession.json, summary.json, and
		// every messages.jsonl line — and only PersistedSession ever carried
		// `threadId`. This is the direct, non-integration check that the
		// other kinds (and every message line) come back byte-identical.
		//
		// toStrictEqual, not toEqual: an unconditional `record.topicId =
		// record.threadId` implementation (no presence check) would add a
		// `topicId: undefined` own-property to a record that never had the
		// key. `toEqual` treats an undefined-valued extra property as no
		// difference; `toStrictEqual` does not.
		const messageLine = {
			id: 'msg_x',
			sessionId: 'ses_x',
			tenantId: TENANT,
			message: createUserMessage('hi'),
			at: new Date().toISOString(),
		}
		expect(migrateSessionStoreThreadIdToTopicId({ ...messageLine })).toStrictEqual(messageLine)

		const subsessionLine = { id: 'sub_x', parentSessionId: 'ses_a', childSessionId: 'ses_b' }
		expect(migrateSessionStoreThreadIdToTopicId({ ...subsessionLine })).toStrictEqual(
			subsessionLine,
		)
	})

	it('migrateSessionStoreThreadIdToTopicId renames threadId and removes it when present', () => {
		const legacySession = {
			id: 'ses_x',
			threadId: 'thd_x',
			projectId: 'prj_x',
			tenantId: TENANT,
		}
		const migrated = migrateSessionStoreThreadIdToTopicId({ ...legacySession })
		expect(migrated).toStrictEqual({
			id: 'ses_x',
			topicId: 'thd_x',
			projectId: 'prj_x',
			tenantId: TENANT,
		})
		expect('threadId' in migrated).toBe(false)
	})
})

describe('topicId thd_ → top_ prefix (NZ-TOPIC-04, v2→v3)', () => {
	it('migrates a v2 session.json whose topicId still carries the thd_ prefix', async () => {
		const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
		const sessionId = 'ses_v2legacy' as SessionId
		const dir = join(rootDir, 'projects', project.id, 'sessions', sessionId)
		await mkdir(dir, { recursive: true })
		// Exactly what NZ-TOPIC-03 alone (pre-NZ-TOPIC-04) wrote: field already
		// renamed to `topicId`, value still `thd_`-prefixed, stamped v2.
		const v2Record = {
			id: sessionId,
			topicId: 'thd_v2',
			projectId: project.id,
			tenantId: TENANT,
			status: 'idle',
			currentActor: null,
			previousActors: [],
			workspaceId: null,
			ownerVersion: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			schemaVersion: 2,
		}
		await writeFile(join(dir, 'session.json'), JSON.stringify(v2Record), 'utf-8')

		const loaded = await store.getSession(sessionId, TENANT)
		expect(loaded).not.toBeNull()
		expect((loaded as unknown as { topicId?: unknown })?.topicId).toBe('top_v2')
	})

	it('running the migration a second time is a no-op: file bytes are unchanged because a read never writes', async () => {
		const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
		const sessionId = 'ses_v2idem' as SessionId
		const dir = join(rootDir, 'projects', project.id, 'sessions', sessionId)
		await mkdir(dir, { recursive: true })
		const v2Record = {
			id: sessionId,
			topicId: 'thd_idem',
			projectId: project.id,
			tenantId: TENANT,
			status: 'idle',
			currentActor: null,
			previousActors: [],
			workspaceId: null,
			ownerVersion: 0,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			schemaVersion: 2,
		}
		const path = join(dir, 'session.json')
		const raw = JSON.stringify(v2Record)
		await writeFile(path, raw, 'utf-8')

		await store.getSession(sessionId, TENANT)
		const afterFirstRead = await readFile(path, 'utf-8')
		await store.getSession(sessionId, TENANT)
		const afterSecondRead = await readFile(path, 'utf-8')

		// Unlike `filesystem.ts`'s marker-gated boot migration, this migration
		// is a lazy per-record read: nothing writes, so "run it twice" cannot
		// double-prefix a value even in principle. Both reads leave the exact
		// pre-migration bytes on disk (still `thd_idem` — only the in-memory
		// return value is migrated), and the two reads agree with each other.
		expect(afterFirstRead).toBe(raw)
		expect(afterSecondRead).toBe(raw)
	})

	it('migrateSessionStoreTopicIdPrefix leaves a record with no topicId untouched (same reference)', () => {
		const projectLine = { id: 'prj_x', tenantId: TENANT, name: 'p' }
		expect(migrateSessionStoreTopicIdPrefix(projectLine)).toBe(projectLine)
	})

	it('migrateSessionStoreTopicIdPrefix leaves an already top_-prefixed topicId untouched (same reference, no double-rewrite)', () => {
		const record = { id: 'ses_x', topicId: 'top_already', tenantId: TENANT }
		// Reference equality, not just value equality: proves the no-op branch
		// returns the SAME object rather than a fresh shallow copy.
		expect(migrateSessionStoreTopicIdPrefix(record)).toBe(record)
	})

	it('migrateSessionStoreTopicIdPrefix rewrites a thd_-prefixed topicId to top_ and nothing else', () => {
		const record = { id: 'ses_x', topicId: 'thd_rewrite', tenantId: TENANT, extra: 'kept' }
		const migrated = migrateSessionStoreTopicIdPrefix({ ...record })
		expect(migrated).toStrictEqual({
			id: 'ses_x',
			topicId: 'top_rewrite',
			tenantId: TENANT,
			extra: 'kept',
		})
	})
})
