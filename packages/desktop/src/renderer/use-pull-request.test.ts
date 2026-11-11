import { describe, expect, it, vi } from 'vitest'
import { POLL_FAILURE_LIMIT } from './failing-poll.js'
import { PULL_REQUEST_POLL_MS, startPullRequestLook } from './use-pull-request.js'

function surfaces() {
	const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
	const window = new EventTarget()
	const listening = (target: EventTarget) => ({
		addEventListener: (type: string, fn: () => void) => target.addEventListener(type, fn),
		removeEventListener: (type: string, fn: () => void) => target.removeEventListener(type, fn),
	})
	return {
		raw: { document, window },
		document: {
			...listening(document),
			get visibilityState() {
				return document.visibilityState
			},
		},
		window: listening(window),
	}
}

describe('startPullRequestLook', () => {
	it('stops looking after repeated failures and looks again, at once, when the window is focused', async () => {
		vi.useFakeTimers()
		try {
			const look = vi.fn(async () => {
				throw new Error('offline')
			})
			const world = surfaces()
			const stop = startPullRequestLook({
				look,
				onFound: () => {},
				document: world.document,
				window: world.window,
			})
			await vi.advanceTimersByTimeAsync(PULL_REQUEST_POLL_MS * 20)
			expect(look).toHaveBeenCalledTimes(POLL_FAILURE_LIMIT)
			world.raw.window.dispatchEvent(new Event('focus'))
			await vi.advanceTimersByTimeAsync(0)
			expect(look).toHaveBeenCalledTimes(POLL_FAILURE_LIMIT + 1)
			// The failure count started over, so the slow poll asks again before giving up.
			await vi.advanceTimersByTimeAsync(PULL_REQUEST_POLL_MS * 20)
			expect(look).toHaveBeenCalledTimes(POLL_FAILURE_LIMIT * 2)
			stop()
		} finally {
			vi.useRealTimers()
		}
	})

	it('asks again when the window becomes visible, and never while it is hidden', async () => {
		vi.useFakeTimers()
		try {
			const look = vi.fn(async () => null)
			const world = surfaces()
			const stop = startPullRequestLook({
				look,
				onFound: () => {},
				document: world.document,
				window: world.window,
			})
			await vi.advanceTimersByTimeAsync(0)
			world.raw.document.visibilityState = 'hidden'
			world.raw.document.dispatchEvent(new Event('visibilitychange'))
			expect(look).toHaveBeenCalledTimes(1)
			world.raw.document.visibilityState = 'visible'
			world.raw.document.dispatchEvent(new Event('visibilitychange'))
			expect(look).toHaveBeenCalledTimes(2)
			stop()
			world.raw.window.dispatchEvent(new Event('focus'))
			expect(look).toHaveBeenCalledTimes(2)
		} finally {
			vi.useRealTimers()
		}
	})
})
