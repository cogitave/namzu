import { PassThrough } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readStdin } from '../stdin.js'

/**
 * Piped input next to a prompt argument gets a quarter second to start; the
 * prompt itself, or an explicit `-`, waits as long as it takes.
 */

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin')
let pipe: PassThrough

beforeEach(() => {
	// Timeouts are the clock under test; setImmediate stays real, because it is
	// the poll-phase turn the deadline hands to the pipe, not a duration.
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
	pipe = new PassThrough()
	Object.defineProperty(process, 'stdin', {
		configurable: true,
		get: () => Object.assign(pipe, { isTTY: false }),
	})
})

afterEach(() => {
	vi.useRealTimers()
	if (realStdin) Object.defineProperty(process, 'stdin', realStdin)
})

/** Whether `promise` has settled, after the timers and one loop turn have run. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
	let done = false
	void promise.then(() => {
		done = true
	})
	await vi.advanceTimersByTimeAsync(0)
	await new Promise((resolve) => setImmediate(resolve))
	return done
}

describe('reading piped input next to a prompt argument', () => {
	it('gives up after a quarter second of silence', async () => {
		const read = readStdin({ deadline: true })

		await vi.advanceTimersByTimeAsync(249)
		expect(await settled(read)).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await expect(read).resolves.toBe('')
	})

	it('reads to the end once a byte has arrived, however long the rest takes', async () => {
		const read = readStdin({ deadline: true })
		await vi.advanceTimersByTimeAsync(100)
		pipe.write('first ')
		await vi.advanceTimersByTimeAsync(5_000)
		expect(await settled(read)).toBe(false)
		pipe.end('and last')

		await expect(read).resolves.toBe('first and last')
	})

	it('returns at once when the pipe is already closed', async () => {
		pipe.end('short')

		await expect(readStdin({ deadline: true })).resolves.toBe('short')
	})

	it('does not wait on a terminal', async () => {
		Object.defineProperty(process, 'stdin', {
			configurable: true,
			get: () => Object.assign(pipe, { isTTY: true }),
		})

		await expect(readStdin({ deadline: true })).resolves.toBe('')
	})
})

describe('reading piped input as the prompt', () => {
	it('waits as long as it takes', async () => {
		const read = readStdin()

		await vi.advanceTimersByTimeAsync(5_000)
		expect(await settled(read)).toBe(false)
		pipe.end('the whole prompt')

		await expect(read).resolves.toBe('the whole prompt')
	})
})
