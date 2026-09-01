/**
 * A closed workspace takes no new conversation from the CLI either.
 *
 * The kernel gained a workspace-closed gate and it was applied to the SDK's own
 * ingress paths. `startConversation` calls `createSession` on the store
 * DIRECTLY, and a store deliberately holds no view of workspace status, so the
 * invariant did not reach here.
 *
 * Whether that mattered turned on one question a grep cannot answer: does the
 * CLI ever reach a project it did not just create? It does. `openSessions`
 * reads the project id back out of `.namzu/cli.json` and creates a new project
 * only when the pointer is missing or stale — so every run after the first
 * attaches to a project that already existed and may since have been closed.
 *
 * That is why this test archives a project created by an EARLIER `openSessions`
 * and then reopens the same directory. A test that archived a project it made
 * itself, in one call, would pass against the first-run case the gate can never
 * fire on.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'

import {
	DefaultPathBuilder,
	ProjectManager,
	type TenantId,
	UNKNOWN_TENANT_ID,
	createUserMessage,
} from '@namzu/sdk'

import {
	appendMessages,
	archiveConversation,
	forkConversation,
	listRecent,
	loadConversation,
	loadResumableConversation,
	openSessions,
	replaceConversation,
	resolveConversation,
	startConversation,
} from '../store.js'

let cwd: string

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-archived-'))
})

afterEach(() => {
	removeTempDir(cwd)
})

describe('a workspace its owner has closed', () => {
	it('refuses a new conversation, instead of quietly accepting work', async () => {
		// First run: creates the project and writes the pointer.
		const first = await openSessions(cwd)
		await new ProjectManager({ store: first.store }).archive(
			first.projectId,
			UNKNOWN_TENANT_ID as TenantId,
		)

		// A later run in the same directory reaches the SAME project through the
		// pointer — the case that exists only from the second run onward.
		const later = await openSessions(cwd)
		expect(later.projectId, 'the pointer has to be what makes this reachable').toBe(first.projectId)

		await expect(startConversation(later)).rejects.toThrow(/archiv|closed/i)
	})

	it('still starts a conversation in an open one', async () => {
		// The other half. A gate nothing can get past has broken the product,
		// and this is the assertion that would catch a `requireOpenProject` call
		// wired to the wrong project id.
		const sessions = await openSessions(cwd)

		const id = await startConversation(sessions)

		expect(typeof id).toBe('string')
		expect(id.length).toBeGreaterThan(0)
	})

	it('names the workspace in the refusal', async () => {
		// A refusal that does not say which workspace sends the reader nowhere:
		// the whole point is that an owner closed this one on purpose.
		const first = await openSessions(cwd)
		await new ProjectManager({ store: first.store }).archive(
			first.projectId,
			UNKNOWN_TENANT_ID as TenantId,
		)

		const later = await openSessions(cwd)

		await expect(startConversation(later)).rejects.toThrow(new RegExp(later.projectId))
	})

	it('keeps existing history readable but refuses resume, fork and mutation', async () => {
		const first = await openSessions(cwd)
		const id = await startConversation(first)
		const original = createUserMessage('durable before close')
		await appendMessages(first, id, [original])
		await new ProjectManager({ store: first.store }).archive(first.projectId, first.tenantId)
		const later = await openSessions(cwd)

		expect(await loadConversation(later, id)).toEqual([original])
		await expect(listRecent(later)).rejects.toThrow(new RegExp(first.projectId))
		await expect(loadResumableConversation(later, id)).rejects.toThrow(/archiv|closed/i)
		await expect(appendMessages(later, id, [createUserMessage('must not land')])).rejects.toThrow(
			/archiv|closed/i,
		)
		await expect(
			replaceConversation(later, id, [createUserMessage('must not replace')]),
		).rejects.toThrow(/archiv|closed/i)
		await expect(forkConversation(later, id)).rejects.toThrow(/archiv|closed/i)
		expect(await loadConversation(later, id)).toEqual([original])
	})

	it('does not let a desktop key silently reactivate its closed conversation', async () => {
		const first = await openSessions(cwd)
		const id = await resolveConversation(first, 'desktop-window')
		await appendMessages(first, id, [createUserMessage('before close')])
		await new ProjectManager({ store: first.store }).archive(first.projectId, first.tenantId)
		const later = await openSessions(cwd)

		await expect(resolveConversation(later, 'desktop-window')).rejects.toThrow(/archiv|closed/i)
		expect(await loadConversation(later, id)).toHaveLength(1)
	})

	it('keeps the fixed CLI topic scoped to the selected project', async () => {
		const old = await openSessions(cwd)
		const oldId = await startConversation(old)
		await appendMessages(old, oldId, [createUserMessage('belongs to old project')])
		const currentProject = await old.store.createProject(
			{ tenantId: old.tenantId, name: 'current project' },
			old.tenantId,
		)
		const currentProjectRoot = new DefaultPathBuilder(old.root).projectDir(currentProject.id)
		const current = {
			...old,
			projectId: currentProject.id,
			projectStateRoot: currentProjectRoot,
			controlRoot: join(currentProjectRoot, 'cli'),
			turnEvidence: undefined,
		}
		const currentId = await startConversation(current)
		await appendMessages(current, currentId, [createUserMessage('belongs to current project')])

		expect((await listRecent(current)).map((row) => row.id)).toEqual([currentId])
		await expect(loadConversation(current, oldId)).rejects.toThrow(/does not belong/i)
		await expect(loadResumableConversation(current, oldId)).rejects.toThrow(/does not belong/i)
	})

	it('treats an archived Session as a read-only tombstone inside an open workspace', async () => {
		const sessions = await openSessions(cwd)
		const id = await startConversation(sessions)
		const original = createUserMessage('kept for inspection')
		await appendMessages(sessions, id, [original])
		const record = await sessions.store.getSession(id, sessions.tenantId)
		if (!record) throw new Error('fixture conversation vanished')
		await sessions.store.updateSession({ ...record, status: 'archived' }, sessions.tenantId)

		expect(await loadConversation(sessions, id)).toEqual([original])
		expect(await listRecent(sessions)).toEqual([])
		await expect(loadResumableConversation(sessions, id)).rejects.toThrow(/archived and read-only/i)
		await expect(
			appendMessages(sessions, id, [createUserMessage('must not land')]),
		).rejects.toThrow(/archived and read-only/i)
		await expect(forkConversation(sessions, id)).rejects.toThrow(/archived and read-only/i)
		expect(await loadConversation(sessions, id)).toEqual([original])
	})

	it('archives one in-scope conversation with a versioned tombstone write', async () => {
		const sessions = await openSessions(cwd)
		const id = await startConversation(sessions)
		const original = createUserMessage('preserved after archive')
		await appendMessages(sessions, id, [original])
		const before = await sessions.store.getSession(id, sessions.tenantId)
		if (!before) throw new Error('fixture conversation vanished')

		await archiveConversation(sessions, id)

		const after = await sessions.store.getSession(id, sessions.tenantId)
		expect(after).toMatchObject({ status: 'archived', ownerVersion: before.ownerVersion + 1 })
		expect(await loadConversation(sessions, id)).toEqual([original])
		expect(await listRecent(sessions)).toEqual([])
		await expect(loadResumableConversation(sessions, id)).rejects.toThrow(/archived and read-only/i)
		await expect(archiveConversation(sessions, id)).rejects.toThrow(/already archived/i)
	})
})
