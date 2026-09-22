import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, createProjectInstructionMessage, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import {
	forkConversation,
	forkConversationBeforeUser,
	listRecent,
	loadConversation,
	nextForkName,
	openConversationLog,
	openSessions,
	readConversationFacts,
	refreshIndex,
	setTitle,
	startConversation,
	titleOf,
} from '../store.js'

/**
 * `/resume` lists conversations by the first thing the operator typed. That is
 * a reasonable default and a bad identity: it stops describing a conversation
 * the moment the work moves on from its opening question, and it is identical
 * for two conversations that began the same way.
 *
 * Forking makes the second half sharp. A fork and its original share every
 * message they have, so both derive the SAME title — two rows a person cannot
 * tell apart, in the list they would use to undo the fork. So the naming is
 * not decoration here; it is what makes forking usable at all.
 */

async function project(): Promise<Awaited<ReturnType<typeof openSessions>>> {
	return openSessions(mkdtempSync(join(tmpdir(), 'namzu-sessions-')), {
		stateRoot: mkdtempSync(join(tmpdir(), 'namzu-sessions-home-')),
	})
}

function said(role: 'user' | 'assistant', content: string): Message {
	return { role, content } as Message
}

describe('naming a conversation', () => {
	it('reports no name before one is given', async () => {
		const s = await project()
		const id = await startConversation(s)

		expect(await titleOf(s, id)).toBeUndefined()
	})

	it('remembers a name as a session_updated record, and reads it back', async () => {
		const s = await project()
		const id = await startConversation(s)

		await setTitle(s, id, 'the auth refactor')

		expect(await titleOf(s, id)).toBe('the auth refactor')
		const facts = await readConversationFacts(s, id)
		expect(facts?.records.at(-1)).toMatchObject({
			type: 'session_updated',
			title: 'the auth refactor',
			titleSource: 'named',
		})
	})

	it('shows the chosen name in the list instead of the opening message', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'why does the build fail'), said('assistant', 'because')])

		await setTitle(s, id, 'flaky build')
		const [row] = await listRecent(s)

		expect(row?.title).toBe('flaky build')
		expect(row?.named).toBe(true)
	})

	it('says a derived title is derived, which the text alone cannot', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'why does the build fail')])

		const [row] = await listRecent(s)

		expect(row?.named).toBe(false)
		expect(row?.title).toBe('why does the build fail')
	})

	it('derives the title from the operator, not a retained policy snapshot', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [
			createProjectInstructionMessage('do not use as a title', ['AGENTS.md']),
			createUserMessage('the operator request'),
		])

		const [row] = await listRecent(s)

		expect(row?.title).toBe('the operator request')
		expect(row?.named).toBe(false)
	})

	it('takes the name away rather than storing an empty one', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'opening question')])
		await setTitle(s, id, 'temporary')

		await setTitle(s, id, '   ')

		expect(await titleOf(s, id)).toBeUndefined()
		const [row] = await listRecent(s)
		expect(row?.title).toBe('opening question')
		expect(row?.named).toBe(false)
	})

	it('keeps other names when one changes', async () => {
		const s = await project()
		const first = await startConversation(s)
		const second = await startConversation(s)
		await setTitle(s, first, 'one')
		await setTitle(s, second, 'two')

		await setTitle(s, first, 'one renamed')

		expect(await titleOf(s, second)).toBe('two')
		expect(await titleOf(s, first)).toBe('one renamed')
	})

	it('omits a conversation with no messages from the list', async () => {
		const s = await project()
		await startConversation(s)

		expect(await listRecent(s)).toEqual([])
	})
})

describe('forking a conversation', () => {
	it('copies the transcript into a new conversation', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'first'), said('assistant', 'second')])

		const forked = await forkConversation(s, id)

		expect(forked.id).not.toBe(id)
		expect(forked.copied).toBe(2)
		expect((await loadConversation(s, forked.id)).map((m) => m.content)).toEqual([
			'first',
			'second',
		])
	})

	it('seeds the fork as one compaction record outside any turn', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'first'), said('assistant', 'second')])

		const forked = await forkConversation(s, id)

		const facts = await readConversationFacts(s, forked.id)
		const seed = facts?.records.find((record) => record.type === 'compaction')
		expect(seed).toMatchObject({ type: 'compaction', strategy: 'fork', trigger: 'manual' })
		expect(seed?.turnId).toBeUndefined()
		expect(facts?.records.some((record) => record.type === 'turn_started')).toBe(false)
	})

	it('leaves the original exactly as it was', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'first')])

		const forked = await forkConversation(s, id)
		await recordTurn(s, forked.id, [said('user', 'only in the fork')])

		expect((await loadConversation(s, id)).map((m) => m.content)).toEqual(['first'])
		expect((await loadConversation(s, forked.id)).map((m) => m.content)).toEqual([
			'first',
			'only in the fork',
		])
	})

	it('names the fork, so the two are not one row twice', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'why does the build fail')])

		const forked = await forkConversation(s, id)
		const titles = (await listRecent(s)).map((row) => row.title)

		expect(forked.title).toBe('why does the build fail (fork)')
		expect(new Set(titles).size).toBe(titles.length)
	})

	it('takes the name from the original when it has one', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'anything')])
		await setTitle(s, id, 'the auth refactor')

		expect((await forkConversation(s, id)).title).toBe('the auth refactor (fork)')
	})

	it('numbers a second fork instead of colliding with the first', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'anything')])

		const one = await forkConversation(s, id)
		const two = await forkConversation(s, id)

		expect(one.title).not.toBe(two.title)
		expect(two.title).toBe('anything (fork 2)')
	})

	it('refuses to fork a conversation with nothing in it', async () => {
		const s = await project()
		const id = await startConversation(s)

		await expect(forkConversation(s, id)).rejects.toThrow(/nothing to fork/i)
	})
})

describe('forking before a selected user prompt', () => {
	it('copies the exact prefix and leaves the source whole', async () => {
		const s = await project()
		const id = await startConversation(s)
		const first = createUserMessage('first surviving prompt', [
			{
				type: 'document',
				data: 'UERG',
				mediaType: 'application/pdf',
				name: 'design.pdf',
				citations: true,
			},
		])
		const answer = { role: 'assistant', content: 'first answer', timestamp: 20 } as Message
		const selected = createUserMessage('rewrite this prompt', [
			{
				type: 'stored',
				ref: 'sha256:abc',
				mediaType: 'image/png',
				kind: 'image',
				name: 'diagram.png',
			},
		])
		const suffix = { role: 'assistant', content: 'answer to remove', timestamp: 40 } as Message
		await recordTurn(s, id, [first, answer])
		await recordTurn(s, id, [selected, suffix])

		const forked = await forkConversationBeforeUser(s, id, 1, selected)

		expect(forked.messages).toEqual([first, answer])
		expect(forked.selected).toEqual(selected)
		expect(await loadConversation(s, forked.id)).toEqual([first, answer])
		expect(await loadConversation(s, id)).toEqual([first, answer, selected, suffix])
	})

	it('allows the first prompt to reopen on an empty branch', async () => {
		const s = await project()
		const id = await startConversation(s)
		const selected = createUserMessage('the opening prompt', [
			{ data: 'aGVsbG8=', mediaType: 'image/png' },
		])
		await recordTurn(s, id, [selected, said('assistant', 'the old answer')])

		const forked = await forkConversationBeforeUser(s, id, 0, selected)

		expect(forked.messages).toEqual([])
		expect(await loadConversation(s, forked.id)).toEqual([])
		expect((await loadConversation(s, id)).map((message) => message.content)).toEqual([
			'the opening prompt',
			'the old answer',
		])
	})

	it('detects a changed selection before it creates any branch', async () => {
		const s = await project()
		const id = await startConversation(s)
		const durable = createUserMessage('durable text')
		await recordTurn(s, id, [durable])
		const before = await s.index.listSessions({ slug: s.slug })

		await expect(
			forkConversationBeforeUser(s, id, 0, { ...durable, content: 'stale picker text' }),
		).rejects.toThrow(/conversation changed.*nothing was forked/i)

		const after = await s.index.listSessions({ slug: s.slug })
		expect(after.map((session) => session.id)).toEqual(before.map((session) => session.id))
	})
})

describe('a compacted conversation', () => {
	it('keeps the opening title after its opening message is folded away', async () => {
		const s = await project()
		const id = await startConversation(s)
		await recordTurn(s, id, [said('user', 'the opening question'), said('assistant', 'an answer')])
		// A manual compaction outside any turn, as `compactSession` records one.
		const log = openConversationLog(s, id)
		const head = await log.head()
		const lease = await log.claim({ holder: 'test-compaction', ttlMs: 10_000 })
		if (!lease || !head) throw new Error('fixture: the log could not be leased')
		await log.append(lease, {
			type: 'compaction',
			compactionId: 'manual-1',
			strategy: 'structured',
			trigger: 'manual',
			replacesSeqRange: [2, head.pointer.seq],
			summary: [{ role: 'system', content: 'the compacted summary' } as Message],
			keptMessageIds: [],
			tokensBefore: 100,
			tokensAfter: 10,
		})
		await log.release(lease)
		await refreshIndex(s, id)

		expect((await loadConversation(s, id)).map((message) => message.content)).toEqual([
			'the compacted summary',
		])
		const [row] = await listRecent(s)
		expect(row?.title).toBe('the opening question')
		expect(row?.named).toBe(false)
	})
})

describe('fork names', () => {
	it('reuses a number that was freed rather than counting forks', () => {
		expect(nextForkName({ a: 'x (fork 2)' }, 'x')).toBe('x (fork)')
		expect(nextForkName({ a: 'x (fork)' }, 'x')).toBe('x (fork 2)')
		expect(nextForkName({ a: 'x (fork)', b: 'x (fork 2)' }, 'x')).toBe('x (fork 3)')
	})

	it('keeps a fork of a fork readable', () => {
		expect(nextForkName({ a: 'x (fork)' }, 'x (fork)')).toBe('x (fork) (fork)')
	})
})
