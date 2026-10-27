import { describe, expect, it } from 'vitest'

import { conversationInUseSentence, minutesUntilFree } from './conversation-in-use.js'

const NOW = 1_700_000_000_000

describe('the minutes until another process gives a conversation back', () => {
	it('rounds a partial minute up, so the person is never told it is free early', () => {
		expect(minutesUntilFree({ holder: 'namzu:42:t', expiresAt: NOW + 61_000 }, NOW, 7)).toBe(2)
		expect(minutesUntilFree({ holder: 'namzu:42:t', expiresAt: NOW + 300_000 }, NOW, 7)).toBe(5)
		expect(minutesUntilFree({ holder: 'namzu:42:t', expiresAt: NOW + 1 }, NOW, 7)).toBe(1)
	})

	it('names nothing for a lease that lapsed, is gone, or is this process’s own', () => {
		expect(minutesUntilFree({ holder: 'namzu:42:t', expiresAt: NOW }, NOW, 7)).toBeUndefined()
		expect(minutesUntilFree(null, NOW, 7)).toBeUndefined()
		expect(
			minutesUntilFree({ holder: 'namzu:7:t', expiresAt: NOW + 60_000 }, NOW, 7),
		).toBeUndefined()
	})

	it('treats a holder that is not a process of ours as another window', () => {
		expect(minutesUntilFree({ holder: 'desktop-main', expiresAt: NOW + 60_000 }, NOW, 7)).toBe(1)
	})

	it('speaks in minutes', () => {
		expect(conversationInUseSentence(3)).toBe(
			'This conversation is in use by another window. It is available again in about 3 minutes.',
		)
	})
})
