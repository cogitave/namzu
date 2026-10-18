import type { Message } from '@namzu/sdk'
import { expect, it } from 'vitest'
import { conversationDrovePc } from '../agent.js'

const user = (content: string) => ({ role: 'user', content }) as unknown as Message
const called = (name: string) =>
	({
		role: 'assistant',
		content: null,
		toolCalls: [{ id: 'call', type: 'function', function: { name, arguments: '{}' } }],
	}) as unknown as Message

// The computer-use tool is mounted in every interactive session, so being
// mounted cannot be what keeps a turn off the small tier: having used it is.
it('counts a conversation as driving the desktop only once it called the computer-use tool', () => {
	expect(conversationDrovePc([user('merhaba')])).toBe(false)
	expect(conversationDrovePc([user('dosyayı oku'), called('read_file')])).toBe(false)
	expect(conversationDrovePc([user('hesap makinesini aç'), called('computer_use')])).toBe(true)
})

it('looks at the recent stretch of work, not the whole history', () => {
	const long = [
		user('hesap makinesini aç'),
		called('computer_use'),
		...Array.from({ length: 30 }, (_, i) => user(`mesaj ${i}`)),
	]
	expect(conversationDrovePc(long)).toBe(false)
})
