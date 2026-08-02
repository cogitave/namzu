import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { ProjectId, SessionId, TenantId, ThreadId, UserId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type { ActorRef } from '../../types/session/actor.js'
import { DiskSessionStore } from '../session/disk.js'

/**
 * The primitive is unit-tested next door. What matters here is that a store
 * actually goes through it — a version that is stamped but never checked,
 * or checked but never stamped, is the same silent read it replaces.
 */

const TENANT = 'tnt_schema' as TenantId
const THREAD = 'thd_schema' as ThreadId

const actor = (): ActorRef => ({ kind: 'user', userId: 'usr_a' as UserId, tenantId: TENANT })

let rootDir: string
let store: DiskSessionStore

beforeEach(() => {
	rootDir = mkdtempSync(join(tmpdir(), 'namzu-schema-'))
	store = new DiskSessionStore({ rootDir })
})

afterEach(() => {
	rmSync(rootDir, { recursive: true, force: true })
})

async function seed(): Promise<{ projectId: ProjectId; sessionId: SessionId }> {
	const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
	const session = await store.createSession(
		{ threadId: THREAD, projectId: project.id, currentActor: actor() },
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
		expect(raw.schemaVersion).toBe(1)
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
		for (const line of lines) expect(JSON.parse(line).schemaVersion).toBe(1)
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
