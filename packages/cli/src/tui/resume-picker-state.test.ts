import { generateSessionId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { RecentConversation } from '../integrations/sessions/store.js'
import { editLine, filterConversations, openingLines } from './resume-picker-state.js'

const row = (over: Partial<RecentConversation>): RecentConversation => ({
	id: generateSessionId(),
	title: 'Untitled',
	named: false,
	updatedAt: '2026-10-27T00:00:00Z',
	count: 1,
	...over,
})

describe('filtering the resume list', () => {
	const list = [
		row({ title: 'Build fails', firstPrompt: 'why does the build fail on CI' }),
		row({ title: 'Release notes', firstPrompt: 'draft notes', preview: 'ship it' }),
	]
	it('keeps everything for an empty search', () => {
		expect(filterConversations(list, '  ')).toHaveLength(2)
	})
	it('finds a word in the title, the first message or the last message, any case', () => {
		expect(filterConversations(list, 'RELEASE').map((r) => r.title)).toEqual(['Release notes'])
		expect(filterConversations(list, 'on ci').map((r) => r.title)).toEqual(['Build fails'])
		expect(filterConversations(list, 'ship').map((r) => r.title)).toEqual(['Release notes'])
	})
	it('needs every word to match', () => {
		expect(filterConversations(list, 'build ship')).toEqual([])
	})
})

describe('the opening lines', () => {
	it('keeps the first non-empty lines and cuts long ones', () => {
		expect(openingLines('one\n\n two \nthree\nfour', 3)).toEqual(['one', 'two', 'three'])
		expect(openingLines('x'.repeat(10), 3, 5)).toEqual(['xxxx…'])
		expect(openingLines(undefined)).toEqual([])
	})
})

describe('editing a line', () => {
	it('appends printable text and removes the last character on backspace', () => {
		expect(editLine('ab', { input: 'c' })).toBe('abc')
		expect(editLine('ab', { input: '', backspace: true })).toBe('a')
	})
	it('ignores navigation, chords and control bytes', () => {
		expect(editLine('ab', { input: 'a', ctrl: true })).toBeNull()
		expect(editLine('ab', { input: '', upArrow: true })).toBeNull()
		expect(editLine('ab', { input: '\u0007' })).toBeNull()
	})
})
