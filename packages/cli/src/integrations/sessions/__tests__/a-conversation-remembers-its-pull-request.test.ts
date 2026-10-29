import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import { pullRequestLabel } from '../../github/pull-request.js'
import {
	linkConversationToPullRequest,
	listRecent,
	openSessions,
	readConversationFacts,
	startConversation,
} from '../store.js'

/**
 * A conversation that opened or changed a pull request carries the link in its
 * own log, and the resume list shows it.
 */

async function project(): Promise<Awaited<ReturnType<typeof openSessions>>> {
	return openSessions(mkdtempSync(join(tmpdir(), 'namzu-pr-link-')), {
		stateRoot: mkdtempSync(join(tmpdir(), 'namzu-pr-link-home-')),
	})
}

const said = (role: 'user' | 'assistant', content: string) => ({ role, content }) as never
const link = {
	number: 42,
	url: 'https://github.com/acme/widgets/pull/42',
	repository: 'acme/widgets',
}

describe('a conversation linked to a pull request', () => {
	it('shows the request in the resume list', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'fix the login bug')])

		expect(await linkConversationToPullRequest(s, id, link)).toBe(true)
		const [row] = await listRecent(s)

		expect(row?.pr).toEqual(link)
		expect(pullRequestLabel(row?.pr ?? link)).toBe('acme/widgets#42')
	})

	it('does not write the same link twice', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'fix the login bug')])
		await linkConversationToPullRequest(s, id, link)
		const before = (await readConversationFacts(s, id))?.records.length

		expect(await linkConversationToPullRequest(s, id, link)).toBe(false)

		expect((await readConversationFacts(s, id))?.records.length).toBe(before)
	})

	it('follows the latest request when the conversation moves to another', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'fix the login bug')])
		await linkConversationToPullRequest(s, id, link)
		await linkConversationToPullRequest(s, id, {
			...link,
			number: 43,
			url: 'https://github.com/acme/widgets/pull/43',
		})

		const [row] = await listRecent(s)

		expect(row?.pr?.number).toBe(43)
	})

	it('leaves a conversation with no link without one', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'hello')])

		const [row] = await listRecent(s)

		expect(row?.pr).toBeUndefined()
	})
})
