import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import {
	appendMessages,
	forkConversation,
	forkConversationBeforeUser,
	listRecent,
	loadConversation,
	nextForkName,
	openSessions,
	replaceConversation,
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
	return openSessions(mkdtempSync(join(tmpdir(), 'namzu-sessions-')))
}

function said(role: 'user' | 'assistant', content: string): Message {
	return { role, content } as Message
}

describe('naming a conversation', () => {
	it('reports no name before one is given', async () => {
		const s = await project()
		const id = await startConversation(s)

		expect(titleOf(s, id)).toBeUndefined()
	})

	it('remembers a name, and reads it back', async () => {
		const s = await project()
		const id = await startConversation(s)

		setTitle(s, id, 'the auth refactor')

		expect(titleOf(s, id)).toBe('the auth refactor')
	})

	it('shows the chosen name in the list instead of the opening message', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [
			said('user', 'why does the build fail'),
			said('assistant', 'because'),
		])

		setTitle(s, id, 'flaky build')
		const [row] = await listRecent(s)

		expect(row?.title).toBe('flaky build')
		expect(row?.named).toBe(true)
	})

	it('says a derived title is derived, which the text alone cannot', async () => {
		// The distinction the list needs: a derived title changes meaning as
		// the conversation moves on, and a chosen one does not.
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'why does the build fail')])

		const [row] = await listRecent(s)

		expect(row?.named).toBe(false)
		expect(row?.title).toBe('why does the build fail')
	})

	it('takes the name away rather than storing an empty one', async () => {
		// An empty string is not a name. Keeping one would show a blank row,
		// which reads as a conversation with nothing in it.
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'opening question')])
		setTitle(s, id, 'temporary')

		setTitle(s, id, '   ')

		expect(titleOf(s, id)).toBeUndefined()
		const [row] = await listRecent(s)
		expect(row?.title).toBe('opening question')
		expect(row?.named).toBe(false)
	})

	it('keeps other names when one changes', async () => {
		const s = await project()
		const first = await startConversation(s)
		const second = await startConversation(s)
		setTitle(s, first, 'one')
		setTitle(s, second, 'two')

		setTitle(s, first, 'one renamed')

		expect(titleOf(s, second)).toBe('two')
	})

	it('survives a titles file a person has broken', async () => {
		// It is a plain JSON file next to the sessions, so it can be edited and
		// it can be wrong. A conversation with no readable name still has a
		// derived one, and refusing to list anything would be a worse answer
		// than falling back to it.
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'still listed')])
		writeFileSync(join(s.root, 'titles.json'), '{ this is not json', 'utf-8')

		const [row] = await listRecent(s)

		expect(row?.title).toBe('still listed')
	})

	it('ignores a non-string name rather than rendering it', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'still listed')])
		writeFileSync(
			join(s.root, 'titles.json'),
			JSON.stringify({ [id]: { not: 'a string' } }),
			'utf-8',
		)

		expect(titleOf(s, id)).toBeUndefined()
		expect((await listRecent(s))[0]?.title).toBe('still listed')
	})

	it('reads chosen names written by the old string-only sidecar', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'opening')])
		writeFileSync(
			join(s.root, 'titles.json'),
			JSON.stringify({ [id]: 'legacy chosen name' }),
			'utf-8',
		)

		expect(titleOf(s, id)).toBe('legacy chosen name')
		expect((await listRecent(s))[0]).toMatchObject({ title: 'legacy chosen name', named: true })
	})
})

describe('forking a conversation', () => {
	it('copies the transcript into a new conversation', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'first'), said('assistant', 'second')])

		const forked = await forkConversation(s, id)

		expect(forked.id).not.toBe(id)
		expect(forked.copied).toBe(2)
		expect((await loadConversation(s, forked.id)).map((m) => m.content)).toEqual([
			'first',
			'second',
		])
	})

	it('leaves the original exactly as it was', async () => {
		// The whole point. A fork that moved the conversation would be a
		// rename with extra steps.
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'first')])

		const forked = await forkConversation(s, id)
		await appendMessages(s, forked.id, [said('user', 'only in the fork')])

		expect((await loadConversation(s, id)).map((m) => m.content)).toEqual(['first'])
	})

	it('names the fork, so the two are not one row twice', async () => {
		// Load-bearing. Both conversations open with the same message, so both
		// DERIVE the same title — and the list a person would use to undo the
		// fork would show two rows they cannot tell apart.
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'why does the build fail')])

		const forked = await forkConversation(s, id)
		const titles = (await listRecent(s)).map((row) => row.title)

		expect(forked.title).toBe('why does the build fail (fork)')
		expect(new Set(titles).size).toBe(titles.length)
	})

	it('takes the name from the original when it has one', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'anything')])
		setTitle(s, id, 'the auth refactor')

		expect((await forkConversation(s, id)).title).toBe('the auth refactor (fork)')
	})

	it('numbers a second fork instead of colliding with the first', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'anything')])

		const one = await forkConversation(s, id)
		const two = await forkConversation(s, id)

		expect(one.title).not.toBe(two.title)
		expect(two.title).toBe('anything (fork 2)')
	})

	it('refuses to fork a conversation with nothing in it', async () => {
		// An empty fork is a session that shows up in the list forever and
		// answers no question.
		const s = await project()
		const id = await startConversation(s)

		await expect(forkConversation(s, id)).rejects.toThrow(/nothing to fork/i)
	})
})

describe('forking before a selected user prompt', () => {
	it('copies the exact prefix and leaves the source byte-for-byte whole', async () => {
		const s = await project()
		const id = await startConversation(s)
		const summary = {
			role: 'system',
			content: 'summary of older work',
			timestamp: 10,
			cacheHint: 'ephemeral',
		} as Message
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
		const source = [summary, first, answer, selected, suffix]
		await appendMessages(s, id, source)

		const forked = await forkConversationBeforeUser(s, id, 1, selected)

		expect(forked.messages).toEqual([summary, first, answer])
		expect(forked.selected).toEqual(selected)
		expect(await loadConversation(s, forked.id)).toEqual([summary, first, answer])
		expect(await loadConversation(s, id)).toEqual(source)
	})

	it('allows the first prompt to reopen on an empty branch', async () => {
		const s = await project()
		const id = await startConversation(s)
		const selected = createUserMessage('the opening prompt', [
			{ data: 'aGVsbG8=', mediaType: 'image/png' },
		])
		await appendMessages(s, id, [selected, said('assistant', 'the old answer')])

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
		await appendMessages(s, id, [durable])
		const before = await s.store.listSessionsByTopic(s.topicId, s.tenantId)

		await expect(
			forkConversationBeforeUser(s, id, 0, { ...durable, content: 'stale picker text' }),
		).rejects.toThrow(/conversation changed.*nothing was forked/i)

		const after = await s.store.listSessionsByTopic(s.topicId, s.tenantId)
		expect(after.map((session) => session.id)).toEqual(before.map((session) => session.id))
	})
})

describe('compacting a conversation', () => {
	it('replaces the durable view and preserves the opening title', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [
			said('user', 'the opening question'),
			said('assistant', 'an old answer'),
			said('user', 'a recent follow-up'),
		])

		await replaceConversation(s, id, [
			{ role: 'system', content: 'the compacted summary' } as Message,
			said('user', 'a recent follow-up'),
		])

		expect((await loadConversation(s, id)).map((message) => message.content)).toEqual([
			'the compacted summary',
			'a recent follow-up',
		])
		const [row] = await listRecent(s)
		expect(row?.title).toBe('the opening question')
		expect(row?.named).toBe(false)
		expect(titleOf(s, id)).toBeUndefined()
	})

	it('does not replace a name the operator chose', async () => {
		const s = await project()
		const id = await startConversation(s)
		await appendMessages(s, id, [said('user', 'opening')])
		setTitle(s, id, 'chosen name')

		await replaceConversation(s, id, [
			{ role: 'system', content: 'summary' } as Message,
			said('user', 'recent'),
		])

		expect(titleOf(s, id)).toBe('chosen name')
	})
})

describe('fork names', () => {
	it('reuses a number that was freed rather than counting forks', () => {
		// Numbered against the names IN USE. A fork that was renamed never held
		// its number, and a name that was removed gives it back.
		expect(nextForkName({ a: 'x (fork 2)' }, 'x')).toBe('x (fork)')
		expect(nextForkName({ a: 'x (fork)' }, 'x')).toBe('x (fork 2)')
		expect(nextForkName({ a: 'x (fork)', b: 'x (fork 2)' }, 'x')).toBe('x (fork 3)')
	})

	it('keeps a fork of a fork readable', () => {
		expect(nextForkName({ a: 'x (fork)' }, 'x (fork)')).toBe('x (fork) (fork)')
	})
})
