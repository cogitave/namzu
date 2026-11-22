import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	SIGNIN_POLL_MS,
	SIGNIN_WATCH_MS,
	type SignInPeek,
	startSignInWatch,
} from './sign-in-watch.js'

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

function watch(answers: SignInPeek[], extra: { ready?: () => boolean } = {}) {
	const queue = [...answers]
	const peek = vi.fn(async (): Promise<SignInPeek> => queue.shift() ?? 'still-required')
	const onCleared = vi.fn()
	const onTimeout = vi.fn()
	const stop = startSignInWatch({ peek, onCleared, onTimeout, ...extra })
	return { peek, onCleared, onTimeout, stop }
}

describe('the sign-in watch', () => {
	it('keeps looking while the page still asks, and never continues', async () => {
		const w = watch([])
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS * 5)
		expect(w.peek).toHaveBeenCalledTimes(5)
		expect(w.onCleared).not.toHaveBeenCalled()
		w.stop()
	})

	it('continues once after two cleared looks in a row', async () => {
		const w = watch(['still-required', 'cleared', 'cleared'])
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS * 2)
		expect(w.onCleared).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS)
		expect(w.onCleared).toHaveBeenCalledTimes(1)
		// It is over: no more looks, no second continue, no timeout.
		await vi.advanceTimersByTimeAsync(SIGNIN_WATCH_MS)
		expect(w.peek).toHaveBeenCalledTimes(3)
		expect(w.onCleared).toHaveBeenCalledTimes(1)
		expect(w.onTimeout).not.toHaveBeenCalled()
	})

	it('needs the two cleared looks to be consecutive', async () => {
		const w = watch(['cleared', 'unknown', 'cleared', 'still-required', 'cleared'])
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS * 5)
		expect(w.onCleared).not.toHaveBeenCalled()
		w.stop()
	})

	it('gives up after ten minutes and says so once', async () => {
		const w = watch([])
		await vi.advanceTimersByTimeAsync(SIGNIN_WATCH_MS)
		expect(w.onTimeout).toHaveBeenCalledTimes(1)
		const looks = w.peek.mock.calls.length
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS * 4)
		expect(w.peek).toHaveBeenCalledTimes(looks)
		expect(w.onCleared).not.toHaveBeenCalled()
	})

	it('stops looking the moment it is stopped (a key press clears the pause)', async () => {
		const w = watch(['cleared', 'cleared', 'cleared'])
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS)
		w.stop()
		await vi.advanceTimersByTimeAsync(SIGNIN_WATCH_MS)
		expect(w.peek).toHaveBeenCalledTimes(1)
		expect(w.onCleared).not.toHaveBeenCalled()
		expect(w.onTimeout).not.toHaveBeenCalled()
	})

	it('skips a look while the screen is busy and restarts the streak', async () => {
		let ready = true
		const w = watch(['cleared', 'cleared', 'cleared'], { ready: () => ready })
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS)
		ready = false
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS * 3)
		expect(w.peek).toHaveBeenCalledTimes(1)
		ready = true
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS)
		expect(w.onCleared).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS)
		expect(w.onCleared).toHaveBeenCalledTimes(1)
	})

	it('treats a look that throws as unknown', async () => {
		const peek = vi.fn(async () => {
			throw new Error('page closed')
		})
		const onCleared = vi.fn()
		const stop = startSignInWatch({ peek, onCleared, onTimeout: vi.fn() })
		await vi.advanceTimersByTimeAsync(SIGNIN_POLL_MS * 3)
		expect(onCleared).not.toHaveBeenCalled()
		stop()
	})
})
