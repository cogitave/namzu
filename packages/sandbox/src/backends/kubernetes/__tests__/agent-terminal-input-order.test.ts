/**
 * Input typed after a resize reaches the program after the resize, and a
 * resize that never finishes cannot hold input back for good.
 *
 * Driven on the real `agent/agent.cjs` ordering primitive with controlled
 * tasks and a fake clock, so no outcome depends on how fast the machine is.
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Agent {
	orderedWithResize(slavePath: string | undefined, task: () => unknown, isResize?: boolean): void
	RESIZE_MAX_WAIT_MS: number
}

const require_ = createRequire(import.meta.url)
const agent = require_(join(__dirname, '../../../../agent/agent.cjs')) as Agent

const PTY = '/dev/pts/test-order'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: () => void } {
	let resolve = () => {}
	let reject = () => {}
	const promise = new Promise<void>((res, rej) => {
		resolve = res
		reject = () => rej(new Error('stty failed'))
	})
	return { promise, resolve, reject }
}

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe('terminal input ordered after a resize', () => {
	it('writes immediately when no resize is pending', () => {
		const seen: string[] = []
		agent.orderedWithResize(PTY, () => seen.push('a'))
		expect(seen).toEqual(['a'])
	})

	it('holds every write behind pending resizes and keeps arrival order', async () => {
		const seen: string[] = []
		const first = deferred()
		const second = deferred()
		agent.orderedWithResize(PTY, () => first.promise.then(() => seen.push('resize1')), true)
		agent.orderedWithResize(PTY, () => seen.push('in1'))
		agent.orderedWithResize(PTY, () => second.promise.then(() => seen.push('resize2')), true)
		for (let i = 0; i < 50; i += 1) agent.orderedWithResize(PTY, () => seen.push(`k${i}`))
		expect(seen).toEqual([])
		first.resolve()
		await vi.advanceTimersByTimeAsync(0)
		expect(seen).toEqual(['resize1', 'in1'])
		second.resolve()
		await vi.advanceTimersByTimeAsync(0)
		expect(seen).toEqual([
			'resize1',
			'in1',
			'resize2',
			...Array.from({ length: 50 }, (_, n) => `k${n}`),
		])
		// And the queue is gone: the next write is synchronous again.
		agent.orderedWithResize(PTY, () => seen.push('after'))
		expect(seen.at(-1)).toBe('after')
	})

	it('releases input when the resize fails', async () => {
		const seen: string[] = []
		const failing = deferred()
		agent.orderedWithResize(PTY, () => failing.promise, true)
		agent.orderedWithResize(PTY, () => seen.push('typed'))
		failing.reject()
		await vi.advanceTimersByTimeAsync(0)
		expect(seen).toEqual(['typed'])
	})

	it('releases input when the resize never finishes', async () => {
		const seen: string[] = []
		agent.orderedWithResize(PTY, () => new Promise(() => {}), true)
		agent.orderedWithResize(PTY, () => seen.push('typed'))
		await vi.advanceTimersByTimeAsync(agent.RESIZE_MAX_WAIT_MS - 1)
		expect(seen).toEqual([])
		await vi.advanceTimersByTimeAsync(1)
		expect(seen).toEqual(['typed'])
	})

	it('does not delay a different terminal', () => {
		const seen: string[] = []
		agent.orderedWithResize(PTY, () => new Promise(() => {}), true)
		agent.orderedWithResize('/dev/pts/other', () => seen.push('other'))
		expect(seen).toEqual(['other'])
	})
})
