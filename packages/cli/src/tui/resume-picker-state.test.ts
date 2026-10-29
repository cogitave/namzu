import { generateSessionId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { RecentConversation } from '../integrations/sessions/store.js'
import {
	editLine,
	filterConversations,
	onlyLinkedToPullRequest,
	openingLines,
} from './resume-picker-state.js'

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

describe('the pull request filter', () => {
	const linked = row({
		title: 'Fix login',
		pr: { number: 42, url: 'https://github.com/acme/widgets/pull/42', repository: 'acme/widgets' },
	})
	const other = row({
		title: 'Tidy docs',
		pr: { number: 7, url: 'https://github.com/acme/widgets/pull/7', repository: 'acme/widgets' },
	})
	const plain = row({ title: 'Chat' })
	const list = [linked, other, plain]

	it('lists every linked conversation and drops the rest', () => {
		expect(onlyLinkedToPullRequest(list, { kind: 'any' }).map((r) => r.title)).toEqual([
			'Fix login',
			'Tidy docs',
		])
	})
	it('narrows to the pull request named', () => {
		expect(
			onlyLinkedToPullRequest(list, { kind: 'number', number: 42 }).map((r) => r.title),
		).toEqual(['Fix login'])
	})
	it('leaves the list alone with no filter', () => {
		expect(onlyLinkedToPullRequest(list, null)).toHaveLength(3)
	})
	it('lets a search find a conversation by its pull request', () => {
		expect(filterConversations(list, 'pr #42').map((r) => r.title)).toEqual(['Fix login'])
		expect(filterConversations(list, 'acme/widgets').map((r) => r.title)).toEqual([
			'Fix login',
			'Tidy docs',
		])
	})
})
