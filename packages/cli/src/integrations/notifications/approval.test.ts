import { afterEach, describe, expect, it, vi } from 'vitest'

import { APPROVAL_NOTIFICATION_MS, ApprovalNotifier } from './approval.js'

function make(opts: { open?: () => boolean } = {}) {
	const state = { lastKey: 0, open: true }
	const sent: number[] = []
	const notifier = new ApprovalNotifier({
		now: Date.now,
		setTimer: (run, ms) => setTimeout(run, ms),
		clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
		lastInteractionAt: () => state.lastKey,
		isDialogOpen: opts.open ?? (() => state.open),
		send: () => sent.push(Date.now()),
	})
	return { state, sent, notifier }
}

describe('ApprovalNotifier', () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it('waits the full delay before saying anything', () => {
		vi.useFakeTimers()
		const { sent, notifier } = make()
		notifier.dialogOpened()
		vi.advanceTimersByTime(APPROVAL_NOTIFICATION_MS - 1)
		expect(sent).toEqual([])
		vi.advanceTimersByTime(1)
		expect(sent).toHaveLength(1)
	})

	it('is cancelled when the dialog is answered', () => {
		vi.useFakeTimers()
		const { sent, notifier } = make()
		notifier.dialogOpened()
		vi.advanceTimersByTime(3_000)
		notifier.dialogClosed()
		vi.advanceTimersByTime(30_000)
		expect(sent).toEqual([])
	})

	it('is not sent if the dialog is gone when the delay ends', () => {
		vi.useFakeTimers()
		const { state, sent, notifier } = make()
		notifier.dialogOpened()
		state.open = false
		vi.advanceTimersByTime(30_000)
		expect(sent).toEqual([])
	})

	it('a keypress postpones it until the person has been quiet for the whole delay', () => {
		vi.useFakeTimers()
		const { state, sent, notifier } = make()
		notifier.dialogOpened()
		vi.advanceTimersByTime(4_000)
		state.lastKey = Date.now()
		vi.advanceTimersByTime(2_000)
		expect(sent, 'the key was 2 s ago').toEqual([])
		vi.advanceTimersByTime(4_000)
		expect(sent).toHaveLength(1)
	})

	it('a newer dialog restarts the count and one notice is sent for it', () => {
		vi.useFakeTimers()
		const { sent, notifier } = make()
		notifier.dialogOpened()
		vi.advanceTimersByTime(5_000)
		notifier.dialogOpened()
		vi.advanceTimersByTime(5_000)
		expect(sent).toEqual([])
		vi.advanceTimersByTime(1_000)
		expect(sent).toHaveLength(1)
	})

	it('says nothing after dispose', () => {
		vi.useFakeTimers()
		const { sent, notifier } = make()
		notifier.dialogOpened()
		notifier.dispose()
		vi.advanceTimersByTime(60_000)
		expect(sent).toEqual([])
	})
})
