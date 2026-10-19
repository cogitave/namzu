import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import {
	listRecent,
	openSessions,
	readConversationFacts,
	recordGeneratedTitle,
	setTitle,
	startConversation,
	titlesOf,
} from '../store.js'

/**
 * A title the small model wrote is stored as a derived title: `/resume` shows
 * it in place of the first message, a name a person chose always wins over it,
 * and taking the name away falls back to the first message, not to a blank row.
 */

async function project(): Promise<Awaited<ReturnType<typeof openSessions>>> {
	return openSessions(mkdtempSync(join(tmpdir(), 'namzu-ai-title-')), {
		stateRoot: mkdtempSync(join(tmpdir(), 'namzu-ai-title-home-')),
	})
}

const said = (role: 'user' | 'assistant', content: string) => ({ role, content }) as never

describe('a title the model wrote', () => {
	it('shows in the resume list in place of the first message, and is not marked as chosen', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'why does the build fail on windows only')])

		expect(await recordGeneratedTitle(s, id, 'Windows build failure')).toBe(true)
		const [row] = await listRecent(s)

		expect(row?.title).toBe('Windows build failure')
		expect(row?.named).toBe(false)
		expect(await titlesOf(s, id)).toEqual({
			generated: 'Windows build failure',
		})
	})

	it('is recorded as a derived title record', async () => {
		const s = await project()
		const id = await startConversation(s)

		await recordGeneratedTitle(s, id, 'Auth refactor')

		const facts = await readConversationFacts(s, id)
		expect(facts?.records.at(-1)).toMatchObject({
			type: 'session_updated',
			title: 'Auth refactor',
			titleSource: 'derived',
		})
	})

	it('never replaces a name a person chose', async () => {
		const s = await project()
		const id = await startConversation(s)
		await setTitle(s, id, 'my own name')

		expect(await recordGeneratedTitle(s, id, 'Something else')).toBe(false)

		expect(await titlesOf(s, id)).toEqual({ named: 'my own name' })
	})

	it('is written once: a second title does not replace the first', async () => {
		const s = await project()
		const id = await startConversation(s)

		expect(await recordGeneratedTitle(s, id, 'First title')).toBe(true)
		expect(await recordGeneratedTitle(s, id, 'Second title')).toBe(false)

		expect(await titlesOf(s, id)).toEqual({ generated: 'First title' })
	})

	it('is replaced by a later /rename', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'opening question about caching')])
		await recordGeneratedTitle(s, id, 'Generated name')

		await setTitle(s, id, 'chosen name')

		expect(await titlesOf(s, id)).toEqual({ named: 'chosen name' })
		const [row] = await listRecent(s)
		expect(row?.title).toBe('chosen name')
	})

	it('falls back to the first message when the name is taken away', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'opening question about caching')])
		await recordGeneratedTitle(s, id, 'Generated name')
		await setTitle(s, id, 'chosen name')

		await setTitle(s, id, '')
		const [row] = await listRecent(s)

		expect(row?.title).toBe('opening question about caching')
	})

	it('ignores an empty title', async () => {
		const s = await project()
		const id = await startConversation(s)

		expect(await recordGeneratedTitle(s, id, '   ')).toBe(false)
		expect(await titlesOf(s, id)).toEqual({})
	})
})
