import { describe, expect, it, vi } from 'vitest'
import { ReconnectRetry } from './reconnect-retry.js'

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
