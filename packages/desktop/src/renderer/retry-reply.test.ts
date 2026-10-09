import { expect, it } from 'vitest'
import { type ThreadState, emptyThread } from '../shared/projection.js'
import type { ChatMessage } from '../shared/protocol.js'
import { retryableAsk, retryableReply } from './retry-reply.js'

const thread = (messages: ChatMessage[], extra: Partial<ThreadState> = {}): ThreadState => ({
	...emptyThread(),
	messages,
	...extra,
})
const user = (text: string, attachments?: ChatMessage['attachments']): ChatMessage => ({
	role: 'user',
	text,
	...(attachments ? { attachments } : {}),
})
const reply = (text: string): ChatMessage => ({ role: 'assistant', text, status: 'completed' })

it('offers the newest reply and the question that led to it', () => {
	const last = reply('B')
	const found = retryableReply(thread([user('one'), reply('A'), user('two'), last]))
	expect(found?.reply).toBe(last)
	expect(found?.prompt).toBe('two')
})

it('offers nothing while a reply is running or a paused turn waits', () => {
	const messages = [user('one'), reply('A')]
	expect(retryableReply(thread(messages, { running: true }))).toBeUndefined()
	expect(
		retryableReply(thread(messages, { retryNotice: 'Retry the paused turn.' })),
	).toBeUndefined()
})

it('does not resend a question that carried a file', () => {
	const file = [{ id: 'f', name: 'a.txt', kind: 'text', size: 1 }] as unknown as NonNullable<
		ChatMessage['attachments']
	>
	expect(retryableReply(thread([user('read this', file), reply('ok')]))).toBeUndefined()
})

it('offers the last question after a failed turn, and only then', () => {
	const failed = thread([user('hello')], { error: 'The model could not be reached.' })
	expect(retryableAsk(failed)).toBe('hello')
	expect(retryableAsk(thread([user('hello')]))).toBeUndefined()
	expect(retryableAsk({ ...failed, running: true })).toBeUndefined()
})
