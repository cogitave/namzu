import { describe, expect, it, vi } from 'vitest'
import { ReconnectRetries, ReconnectRetry } from './reconnect-retry.js'

describe('ReconnectRetry', () => {
	it('asks a failed read once more when the connection comes back, and not before', () => {
		const retries = new ReconnectRetry()
		const retry = vi.fn()
		expect(retries.failed('undo', retry)).toBe(true)
		expect(retry).not.toHaveBeenCalled()
		retries.reconnected()
		expect(retry).toHaveBeenCalledTimes(1)
		retries.reconnected()
		expect(retry).toHaveBeenCalledTimes(1)
	})
	it('a read that fails again after its retry is left alone', () => {
		const retries = new ReconnectRetry()
		const retry = vi.fn()
		retries.failed('undo', retry)
		retries.reconnected()
		expect(retries.failed('undo', retry)).toBe(false)
		retries.reconnected()
		expect(retry).toHaveBeenCalledTimes(1)
	})
	it('a read that worked earns its one retry again, and a forgotten one is never asked', () => {
		const retries = new ReconnectRetry()
		const retry = vi.fn()
		retries.failed('a', retry)
		retries.reconnected()
		retries.succeeded('a')
		expect(retries.failed('a', retry)).toBe(true)
		retries.forget('a')
		retries.reconnected()
		expect(retry).toHaveBeenCalledTimes(1)
	})
})

describe('ReconnectRetries', () => {
	it('keeps one record per project and drops it when its last read is forgotten', () => {
		const retries = new ReconnectRetries()
		retries.failed('p', 'a', () => {})
		retries.failed('p', 'b', () => {})
		expect(retries.size).toBe(1)
		retries.forget('p', 'a')
		expect(retries.size).toBe(1)
		retries.forget('p', 'b')
		expect(retries.size).toBe(0)
	})

	it('asks only the reads of the project that reconnected, and nothing after the project is dropped', () => {
		const retries = new ReconnectRetries()
		const one = vi.fn()
		const two = vi.fn()
		retries.failed('p', 'a', one)
		retries.failed('q', 'a', two)
		retries.reconnected('p')
		expect(one).toHaveBeenCalledTimes(1)
		expect(two).not.toHaveBeenCalled()
		retries.drop('q')
		retries.reconnected('q')
		expect(two).not.toHaveBeenCalled()
		expect(retries.size).toBe(1)
	})
})
