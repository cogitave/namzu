import { describe, expect, it } from 'vitest'

import type { PermissionDecision } from './agent.js'
import { AskQueue, CLOSED_QUESTION } from './permission-asks.js'

const yes: PermissionDecision = { kind: 'approve' }
const no: PermissionDecision = { kind: 'reject', declined: {} }

function queue() {
	const shown: Array<string | null> = []
	const changes: number[] = []
	const asks = new AskQueue<string>(
		(value) => shown.push(value),
		() => changes.push(changes.length),
	)
	return { asks, shown, changes }
}

describe('the questions waiting on the person', () => {
	it('shows the first question at once and the rest in the order they were asked', async () => {
		const { asks, shown } = queue()
		const a = asks.enqueue('a')
		const b = asks.enqueue('b')
		const c = asks.enqueue('c')
		expect(asks.shown).toBe('a')
		expect(asks.waiting).toBe(2)
		asks.answer(yes)
		expect(await a).toEqual(yes)
		expect(asks.shown).toBe('b')
		asks.answer(no)
		expect(await b).toEqual(no)
		expect(asks.shown).toBe('c')
		asks.answer(yes)
		await c
		expect(asks.shown).toBeNull()
		expect(shown).toEqual(['a', 'b', 'c', null])
	})

	it("puts another agent's question behind every question of the person's own conversation", () => {
		const { asks } = queue()
		void asks.enqueue('first')
		void asks.enqueue('agent-1', { background: true })
		void asks.enqueue('own-2')
		void asks.enqueue('agent-2', { background: true })
		void asks.enqueue('own-3')
		const order: string[] = []
		while (asks.shown !== null) {
			order.push(asks.shown)
			asks.answer(yes)
		}
		expect(order).toEqual(['first', 'own-2', 'own-3', 'agent-1', 'agent-2'])
	})

	it('never takes the screen from the question already up', () => {
		const { asks } = queue()
		void asks.enqueue('agent', { background: true })
		void asks.enqueue('own')
		expect(asks.shown).toBe('agent')
	})

	it('counts k of N only while two or more are open, and starts over when none is', () => {
		const { asks } = queue()
		void asks.enqueue('a')
		expect(asks.count()).toBeUndefined()
		void asks.enqueue('b')
		void asks.enqueue('c')
		expect(asks.count()).toEqual({ position: 1, total: 3 })
		asks.answer(yes)
		expect(asks.count()).toEqual({ position: 2, total: 3 })
		asks.answer(yes)
		// Only one is left open: nothing to count.
		expect(asks.count()).toBeUndefined()
		asks.answer(yes)
		void asks.enqueue('d')
		void asks.enqueue('e')
		expect(asks.count()).toEqual({ position: 1, total: 2 })
	})

	it('counts a question closed without being shown as settled', async () => {
		const { asks } = queue()
		void asks.enqueue('a')
		const b = asks.enqueue('b')
		void asks.enqueue('c')
		const closed = asks.settleWhere((value) => (value === 'b' ? yes : undefined))
		expect(closed).toBe(1)
		expect(await b).toEqual(yes)
		expect(asks.shown).toBe('a')
		// b is settled without ever being shown: a is "1 of 3", and after it c is "3 of 3".
		expect(asks.count()).toEqual({ position: 2, total: 3 })
		asks.answer(yes)
		expect(asks.shown).toBe('c')
		expect(asks.count()).toBeUndefined()
	})

	it('re-checks the question on screen as well as those waiting, and shows the next that is left', async () => {
		const { asks, shown } = queue()
		const a = asks.enqueue('a')
		const b = asks.enqueue('b')
		void asks.enqueue('c')
		asks.settleWhere((value) => (value === 'a' || value === 'b' ? yes : undefined))
		expect(await a).toEqual(yes)
		expect(await b).toEqual(yes)
		expect(asks.shown).toBe('c')
		expect(shown).toEqual(['a', 'c'])
	})

	it('closes a question whose signal aborts, shown or waiting, and moves on', async () => {
		const { asks } = queue()
		const first = new AbortController()
		const second = new AbortController()
		const a = asks.enqueue('a', { signal: first.signal })
		const b = asks.enqueue('b', { signal: second.signal })
		void asks.enqueue('c')
		second.abort()
		expect(await b).toBe(CLOSED_QUESTION)
		expect(asks.open).toBe(2)
		first.abort()
		expect(await a).toBe(CLOSED_QUESTION)
		expect(asks.shown).toBe('c')
	})

	it('does not show a question whose signal had already aborted', async () => {
		const { asks } = queue()
		const controller = new AbortController()
		controller.abort()
		expect(await asks.enqueue('a', { signal: controller.signal })).toBe(CLOSED_QUESTION)
		expect(asks.shown).toBeNull()
	})

	it('answers every open question the same way and closes the screen', async () => {
		const { asks, shown } = queue()
		const all = [asks.enqueue('a'), asks.enqueue('b'), asks.enqueue('c')]
		asks.closeAll(no)
		expect(await Promise.all(all)).toEqual([no, no, no])
		expect(asks.open).toBe(0)
		expect(shown).toEqual(['a', null])
		expect(asks.count()).toBeUndefined()
	})

	it('ignores a signal that aborts after the question was answered', async () => {
		const { asks } = queue()
		const controller = new AbortController()
		const a = asks.enqueue('a', { signal: controller.signal })
		void asks.enqueue('b')
		asks.answer(yes)
		expect(await a).toEqual(yes)
		controller.abort()
		expect(asks.shown).toBe('b')
	})
})
