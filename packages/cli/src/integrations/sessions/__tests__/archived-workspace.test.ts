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
import { createUserMessage } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	archiveConversation,
	forkConversation,
	listRecent,
	loadConversation,
	loadResumableConversation,
	openSessions,
	readConversationFacts,
	requireWritableConversation,
	resolveConversation,
	startConversation,
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
		expect(await listRecent(sessions)).toEqual([])
	})
})
