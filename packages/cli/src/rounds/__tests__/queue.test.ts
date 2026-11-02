import { describe, expect, it, vi } from 'vitest'

import { RoundQueue } from '../queue.js'
import type { QueuedPrompt } from '../types.js'

const human = (text: string): QueuedPrompt => ({ kind: 'human', text })
const texts = (queue: RoundQueue) => queue.items().map((prompt) => prompt.text)

describe('RoundQueue', () => {
	it('is a first-in first-out line', () => {
		const queue = new RoundQueue()
		queue.enqueue(human('a'))
		queue.enqueue(human('b'))
		expect(texts(queue)).toEqual(['a', 'b'])
		expect(queue.dequeue()?.text).toBe('a')
		expect(queue.dequeue()?.text).toBe('b')
		expect(queue.dequeue()).toBeUndefined()
	})

	it('answers a synchronous read with the last write, and keeps one array until a change', () => {
		const queue = new RoundQueue()
		const before = queue.items()
		expect(queue.items()).toBe(before)
		queue.enqueue(human('a'))
		expect(queue.items()).not.toBe(before)
		const after = queue.items()
		expect(queue.items()).toBe(after)
	})

	it('discarding empties the line and lifts the hold', () => {
		const queue = new RoundQueue()
		queue.enqueue(human('a'))
		queue.setPause({ outcome: 'failed' })
		queue.discard()
		expect(queue.items()).toEqual([])
		expect(queue.pause()).toBeNull()
	})

	it('counts an explicit continuation and lifts the hold', () => {
		const queue = new RoundQueue()
		queue.setPause({ outcome: 'stopped', source: 'operator-interrupt' })
		expect(queue.epoch()).toBe(0)
		queue.advanceContinuation()
		expect(queue.epoch()).toBe(1)
		expect(queue.pause()).toBeNull()
	})

	it('tells a listener about every change until it unsubscribes', () => {
		const queue = new RoundQueue()
		const listener = vi.fn()
		const stop = queue.subscribe(listener)
		queue.enqueue(human('a'))
		queue.setPause({ outcome: 'failed' })
		expect(listener).toHaveBeenCalledTimes(2)
		stop()
		queue.discard()
		expect(listener).toHaveBeenCalledTimes(2)
	})
})
