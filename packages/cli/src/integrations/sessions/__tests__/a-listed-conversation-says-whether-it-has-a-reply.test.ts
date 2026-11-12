import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import { listRecent, openSessions, startConversation } from '../store.js'

/**
 * Desktop menus decide from this fact for a conversation they have not opened, so it must
 * come from the log and not from anything a window happened to see.
 */

async function project(): Promise<Awaited<ReturnType<typeof openSessions>>> {
	return openSessions(mkdtempSync(join(tmpdir(), 'namzu-replied-')), {
		stateRoot: mkdtempSync(join(tmpdir(), 'namzu-replied-home-')),
	})
}

const said = (role: 'user' | 'assistant', content: string) => ({ role, content }) as never

describe('the resume list and a reply', () => {
	it('marks a conversation whose log holds an answer', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'hello'), said('assistant', 'Hi there.')])
		const [row] = await listRecent(s)
		expect(row?.replied).toBe(true)
	})

	it('does not mark one that holds only a question', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'hello')])
		const [row] = await listRecent(s)
		expect(row?.replied).toBeUndefined()
	})

	it('does not mark one whose only assistant message is empty', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'hello'), said('assistant', '   ')])
		const [row] = await listRecent(s)
		expect(row?.replied).toBeUndefined()
	})
})
