import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STATUS_LINE_DEBOUNCE_MS, StatusLineController } from './controller.js'

interface Run {
	readonly signal: AbortSignal
	readonly command: string
	resolve(text: string | undefined): void
	reject(error: unknown): void
}

function harness() {
	const runs: Run[] = []
	const shown: (string | undefined)[] = []
	const controller = new StatusLineController({
		run: (signal, command) =>
			new Promise((resolve, reject) => {
				runs.push({ signal, command, resolve, reject })
			}),
		onText: (text) => shown.push(text),
	})
	return { controller, runs, shown }
}

describe('StatusLineController', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('runs once at mount and shows the output', async () => {
		const { controller, runs, shown } = harness()
		controller.update({ command: 'a' }, [1])
		expect(runs).toHaveLength(1)
		runs[0]?.resolve('hello')
		await vi.advanceTimersByTimeAsync(0)
		expect(shown).toEqual(['hello'])
	})

	it('folds a burst of input changes into one run 300 ms after the last', async () => {
		const { controller, runs } = harness()
		controller.update({ command: 'a' }, [1])
		runs[0]?.resolve('x')
		await vi.advanceTimersByTimeAsync(0)
		controller.update({ command: 'a' }, [2])
		await vi.advanceTimersByTimeAsync(STATUS_LINE_DEBOUNCE_MS - 1)
		controller.update({ command: 'a' }, [3])
		await vi.advanceTimersByTimeAsync(STATUS_LINE_DEBOUNCE_MS - 1)
		expect(runs).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(runs).toHaveLength(2)
	})

	it('does not run again when nothing it watches changed', async () => {
		const { controller, runs } = harness()
		controller.update({ command: 'a' }, [1, 'x'])
		controller.update({ command: 'a' }, [1, 'x'])
		await vi.advanceTimersByTimeAsync(5_000)
		expect(runs).toHaveLength(1)
	})

	it('runs at once when the command changes', () => {
		const { controller, runs } = harness()
		controller.update({ command: 'a' }, [1])
		controller.update({ command: 'b' }, [1])
		expect(runs.map((run) => run.command)).toEqual(['a', 'b'])
		expect(runs[0]?.signal.aborted).toBe(true)
	})

	it('aborts a running command when a newer run starts and drops its late output', async () => {
		const { controller, runs, shown } = harness()
		controller.update({ command: 'a' }, [1])
		controller.update({ command: 'a' }, [2])
		await vi.advanceTimersByTimeAsync(STATUS_LINE_DEBOUNCE_MS)
		expect(runs[0]?.signal.aborted).toBe(true)
		runs[0]?.resolve('stale')
		runs[1]?.resolve('fresh')
		await vi.advanceTimersByTimeAsync(0)
		expect(shown).toEqual(['fresh'])
	})

	it('re-runs every refreshInterval seconds through the same debounce', async () => {
		const { controller, runs } = harness()
		controller.update({ command: 'a', refreshIntervalSeconds: 10 }, [1])
		runs[0]?.resolve('x')
		await vi.advanceTimersByTimeAsync(9_999)
		expect(runs).toHaveLength(1)
		await vi.advanceTimersByTimeAsync(1 + STATUS_LINE_DEBOUNCE_MS)
		expect(runs).toHaveLength(2)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runs).toHaveLength(3)
	})

	it('clears the line on empty output and on a failed run, rather than keeping a stale one', async () => {
		const { controller, runs, shown } = harness()
		controller.update({ command: 'a' }, [1])
		runs[0]?.resolve('one')
		await vi.advanceTimersByTimeAsync(0)
		controller.update({ command: 'a' }, [2])
		await vi.advanceTimersByTimeAsync(STATUS_LINE_DEBOUNCE_MS)
		runs[1]?.resolve(undefined)
		await vi.advanceTimersByTimeAsync(0)
		controller.update({ command: 'a' }, [3])
		await vi.advanceTimersByTimeAsync(STATUS_LINE_DEBOUNCE_MS)
		runs[2]?.resolve('two')
		await vi.advanceTimersByTimeAsync(0)
		controller.update({ command: 'a' }, [4])
		await vi.advanceTimersByTimeAsync(STATUS_LINE_DEBOUNCE_MS)
		runs[3]?.reject(new Error('boom'))
		await vi.advanceTimersByTimeAsync(0)
		expect(shown).toEqual(['one', undefined, 'two', undefined])
	})

	it('stops cleanly: no more runs, the line cleared', async () => {
		const { controller, runs, shown } = harness()
		controller.update({ command: 'a', refreshIntervalSeconds: 1 }, [1])
		runs[0]?.resolve('x')
		await vi.advanceTimersByTimeAsync(0)
		controller.update(null, [1])
		await vi.advanceTimersByTimeAsync(10_000)
		expect(runs).toHaveLength(1)
		expect(shown).toEqual(['x', undefined])
	})
})
