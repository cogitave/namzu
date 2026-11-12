import { describe, expect, it, vi } from 'vitest'
import { OpenGate } from './open-gate.js'

function deferred() {
	let resolve!: () => void
	let reject!: (reason: unknown) => void
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('OpenGate', () => {
	it('holds work until the promise settles, in order, then runs new work at once', async () => {
		const ready = deferred()
		const gate = new OpenGate(ready.promise)
		const order: string[] = []
		gate.run(() => order.push('first'))
		gate.run(() => order.push('second'))
		await Promise.resolve()
		expect(order).toEqual([])
		expect(gate.isOpen).toBe(false)
		ready.resolve()
		await ready.promise
		await Promise.resolve()
		expect(order).toEqual(['first', 'second'])
		gate.run(() => order.push('third'))
		expect(order).toEqual(['first', 'second', 'third'])
	})

	it('opens on a rejection too, so a face that cannot load never blocks the terminal', async () => {
		const ready = deferred()
		const gate = new OpenGate(ready.promise)
		const job = vi.fn()
		gate.run(job)
		ready.reject(new Error('no face'))
		await ready.promise.catch(() => undefined)
		await Promise.resolve()
		expect(job).toHaveBeenCalledTimes(1)
	})

	it('is open from the start when there is nothing to wait for', () => {
		const job = vi.fn()
		new OpenGate(undefined).run(job)
		expect(job).toHaveBeenCalledTimes(1)
	})
})
