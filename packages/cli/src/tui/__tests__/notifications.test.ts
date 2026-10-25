import { describe, expect, it } from 'vitest'

import {
	DEFAULT_NOTICE_MS,
	EMPTY_NOTICES,
	type Notice,
	type NoticeAction,
	type NoticeState,
	reduce,
} from '../notifications.js'

const note = (key: string, priority: Notice['priority'], extra: Partial<Notice> = {}): Notice => ({
	key,
	text: key,
	priority,
	...extra,
})

function run(actions: readonly NoticeAction[], from: NoticeState = EMPTY_NOTICES) {
	let state = from
	let timer: ReturnType<typeof reduce>['timer']
	for (const action of actions) {
		const step = reduce(state, action)
		state = step.state
		if (step.timer) timer = step.timer
	}
	return { state, timer }
}
const add = (notice: Notice): NoticeAction => ({ type: 'add', notice })

describe('the notice queue', () => {
	it('shows the first notice and starts its timer at the default time', () => {
		const { state, timer } = run([add(note('a', 'low'))])
		expect(state.current?.key).toBe('a')
		expect(timer).toEqual({ kind: 'start', key: 'a', ms: DEFAULT_NOTICE_MS })
	})

	it('uses the time a notice names', () => {
		expect(run([add(note('a', 'low', { timeoutMs: 1000 }))]).timer).toMatchObject({ ms: 1000 })
	})

	it('lets an immediate notice cover a waiting-type one, which returns afterwards', () => {
		const { state } = run([add(note('m', 'medium')), add(note('i', 'immediate'))])
		expect(state.current?.key).toBe('i')
		expect(state.queue.map((n) => n.key)).toEqual(['m'])
		const after = run([{ type: 'expire', key: 'i' }], state)
		expect(after.state.current?.key).toBe('m')
		expect(after.timer).toMatchObject({ kind: 'start', key: 'm' })
	})

	it('drops a covered immediate notice unless it asks to come back', () => {
		const dropped = run([add(note('i1', 'immediate')), add(note('i2', 'immediate'))])
		expect(dropped.state.queue).toEqual([])
		const kept = run([
			add(note('i1', 'immediate', { requeueOnPreempt: true })),
			add(note('i2', 'immediate')),
		])
		expect(kept.state.queue.map((n) => n.key)).toEqual(['i1'])
	})

	it('does not bring back a notice the new one invalidates', () => {
		const { state } = run([
			add(note('m', 'medium')),
			add(note('i', 'immediate', { invalidates: ['m'] })),
		])
		expect(state.queue).toEqual([])
	})

	it('restarts the timer when the same immediate key is added again', () => {
		const { state, timer } = run([add(note('i', 'immediate')), add(note('i', 'immediate'))])
		expect(state.queue).toEqual([])
		expect(timer).toMatchObject({ kind: 'start', key: 'i' })
	})

	it('ignores a duplicate key that is not immediate', () => {
		const { state } = run([
			add(note('a', 'low')),
			add(note('a', 'low')),
			add(note('b', 'low')),
			add(note('b', 'low')),
		])
		expect(state.current?.key).toBe('a')
		expect(state.queue.map((n) => n.key)).toEqual(['b'])
	})

	it('folds a newer notice into the showing one and restarts its timer', () => {
		const fold = (_o: Notice, n: Notice) => n
		const { state, timer } = run([
			add(note('a', 'medium', { fold })),
			add({ ...note('a', 'medium', { fold }), text: 'newer' }),
		])
		expect(state.current?.text).toBe('newer')
		expect(timer).toMatchObject({ kind: 'start', key: 'a' })
	})

	it('folds into a waiting notice in place', () => {
		const fold = (_o: Notice, n: Notice) => n
		const { state } = run([
			add(note('a', 'low')),
			add(note('b', 'low', { fold })),
			add({ ...note('b', 'low', { fold }), text: 'newer' }),
		])
		expect(state.queue.map((n) => n.text)).toEqual(['newer'])
	})

	it('clears the showing notice when a waiting one invalidates it', () => {
		const { state } = run([add(note('a', 'low')), add(note('b', 'low', { invalidates: ['a'] }))])
		expect(state.current?.key).toBe('b')
	})

	it('lets a high notice wait behind a medium one that is up', () => {
		const { state } = run([add(note('m', 'medium')), add(note('h', 'high'))])
		expect(state.current?.key).toBe('m')
		expect(state.queue.map((n) => n.key)).toEqual(['h'])
	})

	it('promotes the best waiting notice, the earlier on a tie', () => {
		const { state } = run([
			add(note('first', 'low')),
			add(note('l1', 'low')),
			add(note('m', 'medium')),
			add(note('l2', 'low')),
			add(note('m2', 'medium')),
			{ type: 'expire', key: 'first' },
		])
		expect(state.current?.key).toBe('m')
	})

	it('promotes the next one when the showing notice is removed, and cancels when none is left', () => {
		const { state } = run([
			add(note('a', 'low')),
			add(note('b', 'low')),
			{ type: 'remove', key: 'a' },
		])
		expect(state.current?.key).toBe('b')
		const empty = reduce(state, { type: 'remove', key: 'b' })
		expect(empty.state.current).toBeNull()
		expect(empty.timer).toEqual({ kind: 'cancel' })
	})

	it('ignores the timer of a notice that is already gone', () => {
		const { state } = run([add(note('a', 'low'))])
		expect(reduce(state, { type: 'expire', key: 'zzz' }).state).toBe(state)
	})
})
