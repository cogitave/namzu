import { describe, expect, it } from 'vitest'

import {
	NO_NEWS,
	type News,
	baselineOf,
	isReply,
	newOutputHint,
	newRepliesRule,
	newsSince,
	promptAfter,
	replyList,
} from './new-output.js'
import { choiceDisplayWidth } from './terminal-choice-text.js'
import type { TranscriptMessage } from './types.js'

const reply = (id: string, content = `text ${id}`): TranscriptMessage => ({
	id,
	role: 'assistant',
	content,
})
const tool = (id: string): TranscriptMessage => ({ id, role: 'tool', content: `call ${id}` })
const user = (id: string): TranscriptMessage => ({ id, role: 'user', content: `ask ${id}` })

const WORDS = { long: 'Jump to latest', short: 'Latest', key: 'End' }

describe('counting replies', () => {
	it('counts replies of the model with visible text, not tool calls or empty ones', () => {
		const list = replyList([user('u'), reply('a'), tool('t'), reply('b', '   '), reply('c')], null)
		expect(list.map((m) => m.id)).toEqual(['a', 'c'])
		expect(isReply({ ...reply('x'), kind: 'recap' })).toBe(false)
	})

	it('places the streaming reply where it stands', () => {
		const list = replyList([reply('a'), reply('c')], { ...reply('b'), pending: true }, 1)
		expect(list.map((m) => m.id)).toEqual(['a', 'b', 'c'])
	})

	it('is no news when nothing came', () => {
		const messages = [reply('a'), tool('t')]
		const base = baselineOf(replyList(messages, null))
		expect(newsSince(base, replyList(messages, null), false)).toEqual(NO_NEWS)
	})

	it('says the reply grew when the newest one is longer and no new one came', () => {
		const base = baselineOf(replyList([reply('a', 'one')], null))
		const news = newsSince(base, replyList([reply('a', 'one two three')], null), true)
		expect(news).toEqual({ count: 0, grown: true, activity: true })
	})

	it('counts one new reply, several, and not the tool calls between them', () => {
		const before = [reply('a')]
		const base = baselineOf(replyList(before, null))
		const one = newsSince(base, replyList([...before, tool('t1'), reply('b')], null), true)
		expect(one.count).toBe(1)
		const many = newsSince(
			base,
			replyList(
				[...before, tool('t1'), reply('b'), tool('t2'), tool('t3'), reply('c'), reply('d')],
				null,
			),
			true,
		)
		expect(many.count).toBe(3)
		expect(many.grown).toBe(false)
	})

	it('does not count a streaming reply twice when it is finished', () => {
		const streaming = { ...reply('b', 'half'), pending: true }
		const base = baselineOf(replyList([reply('a')], streaming))
		const finished = newsSince(base, replyList([reply('a'), reply('b', 'half done')], null), true)
		expect(finished.count).toBe(0)
		expect(finished.grown).toBe(true)
	})

	it('knows the conversation moved on once the person sends a message', () => {
		const messages = [reply('a'), reply('b')]
		expect(promptAfter(messages, 'b')).toBe(false)
		expect(promptAfter([...messages, user('u')], 'b')).toBe(true)
		expect(promptAfter(messages, 'gone')).toBe(true)
	})
})

describe('the hint', () => {
	const two: News = { count: 2, grown: false, activity: true }
	const one: News = { count: 1, grown: false, activity: true }
	const grown: News = { count: 0, grown: true, writing: true, activity: true }
	const other: News = { count: 0, grown: false, activity: true }

	it('names the count, singular and plural, and the key', () => {
		expect(newOutputHint(80, one, WORDS)).toBe('1 new reply · ↓ Jump to latest · End')
		expect(newOutputHint(80, two, WORDS)).toBe('2 new replies · ↓ Jump to latest · End')
		expect(newOutputHint(80, NO_NEWS, WORDS)).toBe('↓ Jump to latest · End')
	})

	it('says it differently when the reply only grew, or something other than a reply came', () => {
		expect(newOutputHint(80, grown, WORDS)).toBe('Reply still growing · ↓ Jump to latest · End')
		expect(newOutputHint(80, other, WORDS)).toBe('New activity · ↓ Jump to latest · End')
	})

	it('shortens by steps and ends at the count alone', () => {
		expect(newOutputHint(30, two, WORDS)).toBe('2 new replies · ↓ Latest · End')
		expect(newOutputHint(17, two, WORDS)).toBe('2 new · ↓ Latest')
		expect(newOutputHint(8, two, WORDS)).toBe('2 new ↓')
		expect(newOutputHint(3, two, WORDS)).toBe('2')
		expect(newOutputHint(0, two, WORDS)).toBeNull()
	})

	it('fits every width from 1 to 120 and never ends mid-word', () => {
		const words = new Set([
			'reply',
			'replies',
			'new',
			'Jump',
			'to',
			'latest',
			'Latest',
			'End',
			'still',
			'growing',
			'Reply',
			'Growing',
			'grew',
			'Grew',
			'New',
			'activity',
		])
		for (const news of [
			NO_NEWS,
			one,
			two,
			grown,
			{ ...grown, writing: false },
			other,
			{ ...two, count: 12 },
		]) {
			for (let columns = 1; columns <= 120; columns++) {
				const hint = newOutputHint(columns, news, WORDS)
				if (hint === null) continue
				expect(choiceDisplayWidth(hint)).toBeLessThanOrEqual(columns)
				for (const word of hint.split(/[ ·]+/u)) {
					if (word === '' || word === '↓' || /^\d+$/u.test(word)) continue
					expect(words.has(word)).toBe(true)
				}
			}
		}
	})

	it('widths 20 to 120 keep the count in sight whenever there is one', () => {
		for (let columns = 20; columns <= 120; columns++)
			expect(newOutputHint(columns, two, WORDS)).toMatch(/^2 new/u)
	})
})

describe('the rule', () => {
	it('says the count, centred between dashes, inside the width', () => {
		const rule = newRepliesRule(3, 40)
		expect(rule).toContain(' 3 new replies ')
		expect(choiceDisplayWidth(rule)).toBe(40)
		expect(newRepliesRule(1, 40)).toContain(' 1 new reply ')
	})

	it('drops the dashes when there is no room for them', () => {
		expect(newRepliesRule(2, 13)).toBe('2 new replies')
	})

	it('shortens its words on a narrow row and never passes the width', () => {
		for (const count of [1, 2, 12, 120]) {
			for (let width = 0; width <= 30; width++) {
				expect(choiceDisplayWidth(newRepliesRule(count, width))).toBeLessThanOrEqual(width)
			}
		}
		expect(newRepliesRule(2, 10)).toBe('2 new')
		expect(newRepliesRule(2, 1)).toBe('2')
		expect(newRepliesRule(12, 1)).toBe('1')
	})

	it('says a reply that has finished grew, and one still being written is still growing', () => {
		const base = baselineOf(replyList([reply('a', 'one')], null))
		const longer = replyList([reply('a', 'one two')], null)
		const writing = newsSince(base, longer, false, true)
		const done = newsSince(base, longer, false, false)
		expect(newOutputHint(80, writing, WORDS)).toContain('Reply still growing')
		expect(newOutputHint(80, done, WORDS)).toContain('Reply grew')
		expect(newOutputHint(80, done, WORDS)).not.toContain('still growing')
	})
})
