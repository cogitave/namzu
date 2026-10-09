import { describe, expect, it } from 'vitest'
import { emptyThread } from '../shared/projection.js'
import type { ThreadState } from '../shared/projection.js'
import type { ConversationView } from '../shared/protocol.js'
import { conversationsAttention, palsAttention } from './sidebar-section-attention.js'

const view = (id: string) => ({ id, projectId: 'p', title: id }) as unknown as ConversationView
const thread = (patch: Partial<ThreadState>): ThreadState => ({ ...emptyThread(), ...patch })

describe('palsAttention', () => {
	it('names the Pals with a new message and ignores the open one', () => {
		expect(palsAttention(['a', 'b'], new Set(['a']))).toBe('1 Pal has a new message')
		expect(palsAttention(['a', 'b', 'c'], new Set(['a', 'b']))).toBe('2 Pals have new messages')
		expect(palsAttention(['a', 'b'], new Set(['a']), 'a')).toBeUndefined()
	})
	it('says nothing when no listed Pal is unread', () => {
		expect(palsAttention([], new Set(['a']))).toBeUndefined()
		expect(palsAttention(['a'], new Set())).toBeUndefined()
		expect(palsAttention(['a'], undefined)).toBeUndefined()
		expect(palsAttention(['a'], new Set(['gone']))).toBeUndefined()
	})
})

describe('conversationsAttention', () => {
	const waiting = thread({
		running: true,
		permissions: [{ id: 'x' } as unknown as ThreadState['permissions'][number]],
	})
	it('puts a conversation waiting for an answer first', () => {
		const threads = { a: thread({ running: true }), b: waiting }
		expect(conversationsAttention([view('a'), view('b')], threads)).toBe(
			'A conversation is waiting for you',
		)
	})
	it('counts several waiting conversations', () => {
		const threads = { a: waiting, b: waiting }
		expect(conversationsAttention([view('a'), view('b')], threads)).toBe(
			'2 conversations are waiting for you',
		)
	})
	it('reports running ones when nothing waits', () => {
		const threads = { a: thread({ running: true }), b: thread({ running: true }) }
		expect(conversationsAttention([view('a')], threads)).toBe('A conversation is running')
		expect(conversationsAttention([view('a'), view('b')], threads)).toBe(
			'2 conversations are running',
		)
	})
	it('says nothing for idle conversations or ones outside the list', () => {
		expect(conversationsAttention([view('a')], { a: thread({}) })).toBeUndefined()
		expect(conversationsAttention([view('a')], { z: waiting })).toBeUndefined()
		expect(conversationsAttention([], {})).toBeUndefined()
	})
})
