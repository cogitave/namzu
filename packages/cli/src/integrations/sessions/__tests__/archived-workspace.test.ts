/**
 * An archived conversation is a read-only tombstone.
 *
 * Archiving is `session_updated{archived: true}` in the conversation's own
 * log, so the tombstone survives an index rebuild and every process that
 * reads the log sees it. History stays readable — `history` and export are
 * inspection surfaces — while resume, fork and a new desktop turn refuse.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asTenantId, createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	ConversationIndexRefreshError,
	archiveConversation,
	closeSessions,
	forkConversation,
	listArchived,
	listRecent,
	loadConversation,
	loadResumableConversation,
	openConversationLog,
	openSessions,
	readConversationFacts,
	refreshIndex,
	requireWritableConversation,
	resolveConversation,
	startConversation,
	unarchiveConversation,
} from '../store.js'

let cwd: string
let stateRoot: string

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), 'namzu-archived-'))
	stateRoot = mkdtempSync(join(tmpdir(), 'namzu-archived-home-'))
})

afterEach(() => {
	removeTempDir(cwd)
	removeTempDir(stateRoot)
})

describe('an archived conversation', () => {
	it('keeps history readable but refuses resume, fork and a new turn', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		const original = createUserMessage('kept for inspection')
		await recordTurn(sessions, id, [original])

		await archiveConversation(sessions, id)

		// `recordTurn` (a fixture standing in for the kernel's own recorder)
		// writes `original` under a fresh id without stamping it back onto this
		// object, the way the real turn recorder does.
		const [loaded] = await loadConversation(sessions, id)
		expect(loaded).toMatchObject(original)
		expect(await listRecent(sessions)).toEqual([])
		await expect(loadResumableConversation(sessions, id)).rejects.toThrow(/archived and read-only/i)
		await expect(requireWritableConversation(sessions, id, 'start turn')).rejects.toThrow(
			/archived and read-only.*start turn/i,
		)
		await expect(forkConversation(sessions, id)).rejects.toThrow(/archived and read-only/i)
		await expect(archiveConversation(sessions, id)).rejects.toThrow(/already archived/i)
		expect((await readConversationFacts(sessions, id))?.records.at(-1)).toMatchObject({
			type: 'session_updated',
			archived: true,
		})
	})

	it('stays archived when the index is deleted and rebuilt from the logs', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await recordTurn(sessions, id, [createUserMessage('before archive')])
		await archiveConversation(sessions, id)
		sessions.index.close()
		rmSync(join(stateRoot, 'index.sqlite'), { force: true })

		const reopened = await openSessions(cwd, { stateRoot })

		expect(await listRecent(reopened)).toEqual([])
		expect((await reopened.index.getSession(id))?.archived).toBe(true)
	})

	it('lists an archived conversation, restores it, and resumes its original history after an index rebuild', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await recordTurn(sessions, id, [createUserMessage('work to continue')])
		await archiveConversation(sessions, id)

		expect((await listArchived(sessions)).map((row) => row.id)).toEqual([id])
		await unarchiveConversation(sessions, id)
		expect(await listArchived(sessions)).toEqual([])
		expect((await loadResumableConversation(sessions, id))[0]).toMatchObject({
			role: 'user',
			content: 'work to continue',
		})
		expect((await listRecent(sessions)).map((row) => row.id)).toEqual([id])
		expect((await readConversationFacts(sessions, id))?.records.at(-1)).toMatchObject({
			type: 'session_updated',
			archived: false,
		})

		sessions.index.close()
		rmSync(join(stateRoot, 'index.sqlite'), { force: true })
		const reopened = await openSessions(cwd, { stateRoot })
		expect((await reopened.index.getSession(id))?.archived).toBe(false)
		expect((await listRecent(reopened)).map((row) => row.id)).toEqual([id])
		expect((await loadResumableConversation(reopened, id))[0]).toMatchObject({
			content: 'work to continue',
		})
	})

	it('keeps even an empty archived conversation discoverable, then refuses a second restoration', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await archiveConversation(sessions, id)
		expect((await listArchived(sessions)).map((row) => row.id)).toEqual([id])
		await unarchiveConversation(sessions, id)
		await expect(unarchiveConversation(sessions, id)).rejects.toThrow(/already active/i)
	})

	it('pages archived conversations without hiding older ones', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const first = await startConversation(sessions)
		const second = await startConversation(sessions)
		await archiveConversation(sessions, first)
		await archiveConversation(sessions, second)
		const one = await listArchived(sessions, 1, 0)
		const two = await listArchived(sessions, 1, 1)
		expect(new Set([one[0]?.id, two[0]?.id])).toEqual(new Set([first, second]))
	})

	it('serializes competing restorations so exactly one writes the transition', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await archiveConversation(sessions, id)
		const outcomes = await Promise.allSettled([
			unarchiveConversation(sessions, id),
			unarchiveConversation(sessions, id),
		])
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
		expect(
			(await readConversationFacts(sessions, id))?.records.filter(
				(record) => record.type === 'session_updated' && record.archived === false,
			),
		).toHaveLength(1)
	})

	it('repairs a failed incremental index refresh with a full sync', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await archiveConversation(sessions, id)
		vi.spyOn(sessions.index, 'refresh').mockRejectedValueOnce(
			new Error('incremental refresh failed'),
		)
		await unarchiveConversation(sessions, id)
		expect((await sessions.index.getSession(id))?.archived).toBe(false)
		expect((await listRecent(sessions)).map((row) => row.id)).toEqual([]) // empty, but active
		expect(await listArchived(sessions)).toEqual([])
	})

	it('names durable success when both index repairs fail, then rebuilds on reopen', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await recordTurn(sessions, id, [createUserMessage('still here')])
		await archiveConversation(sessions, id)
		vi.spyOn(sessions.index, 'refresh').mockRejectedValueOnce(
			new Error('incremental refresh failed'),
		)
		vi.spyOn(sessions.index, 'sync').mockRejectedValueOnce(new Error('full sync failed'))
		await expect(unarchiveConversation(sessions, id)).rejects.toMatchObject({
			name: ConversationIndexRefreshError.name,
			message: expect.stringContaining('was restored in its durable log'),
		})
		expect((await readConversationFacts(sessions, id))?.archived).toBe(false)
		closeSessions(sessions)
		const reopened = await openSessions(cwd, { stateRoot })
		expect((await reopened.index.getSession(id))?.archived).toBe(false)
		expect((await listRecent(reopened)).map((row) => row.id)).toEqual([id])
	})

	it('refuses archive while a paused turn is still open', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await recordTurn(sessions, id, [createUserMessage('waiting for a person')], {
			status: 'paused',
		})
		await expect(archiveConversation(sessions, id)).rejects.toThrow(/open turn/i)
		expect((await readConversationFacts(sessions, id))?.archived).toBe(false)
	})

	it('restores a historical archived conversation with a parked turn for explicit resolution', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await recordTurn(sessions, id, [createUserMessage('waiting for a person')], {
			status: 'paused',
		})
		// Older /archive wrote this marker even with an open turn. Reproduce that
		// durable state directly, as the current archive gate correctly refuses it.
		const log = openConversationLog(sessions, id)
		const lease = await log.claim({ holder: 'legacy-fixture', ttlMs: 30_000 })
		if (!lease) throw new Error('could not claim legacy fixture log')
		try {
			await log.append(lease, { type: 'session_updated', archived: true })
		} finally {
			await log.release(lease)
		}
		await refreshIndex(sessions, id)
		await expect(loadResumableConversation(sessions, id)).rejects.toThrow(/archived/i)
		await unarchiveConversation(sessions, id)
		expect((await readConversationFacts(sessions, id))?.activeTurn?.paused).toBe(true)
		expect((await loadResumableConversation(sessions, id))[0]).toMatchObject({
			content: 'waiting for a person',
		})
	})

	it('does not let a desktop key silently reactivate its archived conversation', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await resolveConversation(sessions, 'desktop-window')
		await recordTurn(sessions, id, [createUserMessage('before archive')])
		await archiveConversation(sessions, id)

		await expect(resolveConversation(sessions, 'desktop-window')).rejects.toThrow(/archived/i)
		expect(await loadConversation(sessions, id)).toHaveLength(1)
	})

	it('refuses a conversation that belongs to another project', async () => {
		const other = await openSessions(mkdtempSync(join(tmpdir(), 'namzu-other-')), { stateRoot })
		const foreign = await startConversation(other)
		await recordTurn(other, foreign, [createUserMessage('belongs to the other project')])
		const sessions = await openSessions(cwd, { stateRoot })

		await expect(loadConversation(sessions, foreign)).rejects.toThrow(/not found/i)
		await expect(loadResumableConversation(sessions, foreign)).rejects.toThrow(/not found/i)
		await expect(unarchiveConversation(sessions, foreign)).rejects.toThrow(/not found/i)
		expect(await listRecent(sessions)).toEqual([])
		expect(await listArchived(sessions)).toEqual([])
	})

	it('never lists or restores another installation tenant’s conversation', async () => {
		const sessions = await openSessions(cwd, { stateRoot })
		const id = await startConversation(sessions)
		await archiveConversation(sessions, id)
		const wrongTenant = {
			...sessions,
			tenantId: asTenantId('d864e831-a54e-48cd-a706-892960677182'),
		}
		expect(await listArchived(wrongTenant)).toEqual([])
		await expect(unarchiveConversation(wrongTenant, id)).rejects.toThrow(/does not belong/i)
		expect((await readConversationFacts(sessions, id))?.archived).toBe(true)
	})
})
