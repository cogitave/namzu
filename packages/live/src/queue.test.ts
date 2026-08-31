import { describe, expect, it } from 'vitest'

import { WeightedAsyncQueue } from './queue.js'

describe('WeightedAsyncQueue', () => {
	it('backpressures one producer by weight and releases it when the consumer makes room', async () => {
		const queue = new WeightedAsyncQueue<string>(4)
		await queue.push('full', 4)
		let secondSettled = false
		const second = queue.push('next', 4).then(() => {
			secondSettled = true
		})
		await Promise.resolve()
		expect(secondSettled).toBe(false)

		await expect(queue.next()).resolves.toEqual({ done: false, value: 'full' })
		await second
		await expect(queue.next()).resolves.toEqual({ done: false, value: 'next' })
	})

	it('never admits a realtime item beyond its weight budget', () => {
		const queue = new WeightedAsyncQueue<string>(10)
		expect(queue.tryPush('first', 7)).toBe(true)
		expect(queue.tryPush('overflow', 4)).toBe(false)
		expect(queue.weight).toBe(7)
	})

	it('settles blocked readers and writers exactly once when closed with an error', async () => {
		const failure = new Error('closed')
		const readers = new WeightedAsyncQueue<string>(1)
		const read = readers.next()
		readers.close(failure)
		await expect(read).rejects.toBe(failure)

		const writers = new WeightedAsyncQueue<string>(1)
		await writers.push('first', 1)
		const write = writers.push('second', 1)
		writers.close(failure)
		await expect(write).rejects.toBe(failure)
		await expect(writers.next()).rejects.toBe(failure)
	})

	it('removes an aborted producer instead of retaining an unbounded waiter', async () => {
		const queue = new WeightedAsyncQueue<string>(1)
		await queue.push('first', 1)
		const controller = new AbortController()
		const waiting = queue.push('aborted', 1, controller.signal)
		controller.abort(new Error('stop'))

		await expect(waiting).rejects.toThrow('stop')
		await expect(queue.next()).resolves.toEqual({ done: false, value: 'first' })
		expect(queue.weight).toBe(0)
	})
})
