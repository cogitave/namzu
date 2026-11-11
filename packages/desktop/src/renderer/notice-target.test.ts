import { describe, expect, it } from 'vitest'
import type { ConversationView } from '../shared/protocol.js'
import { noticeClickAction } from './notice-target.js'

const row = (id: string, projectId?: string) => ({ id, projectId }) as ConversationView

describe('a clicked notification', () => {
	const open = { loaded: true, frozen: false }
	it('opens the conversation when the list has it', () => {
		const a = row('a', 'p')
		expect(noticeClickAction('a', { ...open, conversations: [a] })).toEqual({
			kind: 'open',
			view: a,
		})
	})
	it('goes Home when the loaded list does not have it, or it has no project', () => {
		expect(noticeClickAction('a', { ...open, conversations: [row('b', 'p')] })).toEqual({
			kind: 'home',
		})
		expect(noticeClickAction('a', { ...open, conversations: [row('a')] })).toEqual({ kind: 'home' })
	})
	it('waits for the list to load instead of guessing, and for a frozen window', () => {
		expect(noticeClickAction('a', { loaded: false, frozen: false, conversations: [] })).toEqual({
			kind: 'wait',
		})
		expect(
			noticeClickAction('a', { ...open, frozen: true, conversations: [row('a', 'p')] }),
		).toEqual({
			kind: 'wait',
		})
	})
	it('opens it once the list arrives', () => {
		const a = row('a', 'p')
		expect(noticeClickAction('a', { loaded: false, frozen: false, conversations: [a] }).kind).toBe(
			'open',
		)
	})
})
