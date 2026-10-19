import { describe, expect, it, vi } from 'vitest'

import { IDLE_NOTIFICATION_MS, IdleNotifier, type IdleNotifierDeps } from './idle.js'

/** A clock the test turns by hand, so no assertion depends on how fast the host is. */
function harness(overrides: Partial<IdleNotifierDeps> = {}) {
	vi.useFakeTimers()
	const state = {
		interactedAt: 0,
		running: false,
		dialog: false,
		pendingWake: false,
		background: false,
	}
	const send = vi.fn()
	const notifier = new IdleNotifier({
		now: () => Date.now(),
		setTimer: (run, ms) => setTimeout(run, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		lastInteractionAt: () => state.interactedAt,
		isTurnRunning: () => state.running,
		isDialogOpen: () => state.dialog,
		hasPendingWake: () => state.pendingWake,
		hasBackgroundWork: () => state.background,
		send,
		...overrides,
	})
	return { notifier, state, send }
}

describe('the idle notice', () => {
	it('waits the full minute, then says so once', () => {
		const { notifier, send } = harness()
		notifier.turnSettled()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS - 1)
		expect(send).not.toHaveBeenCalled()
		vi.advanceTimersByTime(1)
		expect(send).toHaveBeenCalledOnce()
		vi.advanceTimersByTime(10 * IDLE_NOTIFICATION_MS)
		expect(send).toHaveBeenCalledOnce()
		vi.useRealTimers()
	})

	it('is silent when a key was pressed after the turn ended', () => {
		const { notifier, state, send } = harness()
		notifier.turnSettled()
		vi.advanceTimersByTime(10_000)
		state.interactedAt = Date.now()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	it('is silent while a dialog is open or a message is queued to run', () => {
		const { notifier, state, send } = harness()
		state.dialog = true
		notifier.turnSettled()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).not.toHaveBeenCalled()

		state.dialog = false
		state.pendingWake = true
		notifier.turnSettled()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).not.toHaveBeenCalled()
		vi.useRealTimers()
	})

	it('starts over when a new turn begins and ends', () => {
		const { notifier, send } = harness()
		notifier.turnSettled()
		vi.advanceTimersByTime(40_000)
		notifier.turnStarted()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).not.toHaveBeenCalled()
		notifier.turnSettled()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).toHaveBeenCalledOnce()
		vi.useRealTimers()
	})

	it('announces the next completion even after the last one was announced', () => {
		const { notifier, send } = harness()
		notifier.turnSettled()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		notifier.turnStarted()
		vi.advanceTimersByTime(1_000)
		notifier.turnSettled()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).toHaveBeenCalledTimes(2)
		vi.useRealTimers()
	})

	it('waits for background work to finish, then counts again', () => {
		const { notifier, state, send } = harness()
		state.background = true
		notifier.turnSettled()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).not.toHaveBeenCalled()

		state.background = false
		notifier.backgroundChanged()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).toHaveBeenCalledOnce()
		vi.useRealTimers()
	})

	it('says nothing after dispose', () => {
		const { notifier, send } = harness()
		notifier.turnSettled()
		notifier.dispose()
		vi.advanceTimersByTime(IDLE_NOTIFICATION_MS)
		expect(send).not.toHaveBeenCalled()
		vi.useRealTimers()
	})
})
