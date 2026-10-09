import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SIZE_WATCH_INTERVAL_MS, watchOutputSize } from './output-size-watch.js'

/** A terminal stream whose console size can change without any notification, as on the pseudo-console. */
function fakeOutput(initial: number) {
	const out = Object.assign(new EventEmitter(), {
		isTTY: true as boolean | undefined,
		columns: initial,
		live: initial,
		_refreshSize() {
			if (out.columns === out.live) return
			out.columns = out.live
			out.emit('resize')
		},
	})
	return out
}

describe('watchOutputSize', () => {
	beforeEach(() => vi.useFakeTimers())
	afterEach(() => vi.useRealTimers())

	it('raises resize after the console narrows without telling anyone', () => {
		const out = fakeOutput(100)
		const seen: number[] = []
		out.on('resize', () => seen.push(out.columns))
		const stop = watchOutputSize(out, 'win32')
		expect(stop).toBeTypeOf('function')
		out.live = 46
		vi.advanceTimersByTime(SIZE_WATCH_INTERVAL_MS)
		expect(seen).toEqual([46])
		vi.advanceTimersByTime(SIZE_WATCH_INTERVAL_MS * 4)
		expect(seen).toEqual([46])
		stop?.()
	})

	it('stops asking once stopped', () => {
		const out = fakeOutput(100)
		const refresh = vi.spyOn(out, '_refreshSize')
		const stop = watchOutputSize(out, 'win32')
		vi.advanceTimersByTime(SIZE_WATCH_INTERVAL_MS)
		expect(refresh).toHaveBeenCalledTimes(1)
		stop?.()
		vi.advanceTimersByTime(SIZE_WATCH_INTERVAL_MS * 3)
		expect(refresh).toHaveBeenCalledTimes(1)
	})

	it('watches nothing off Windows, off a terminal, or where Node offers no refresh', () => {
		expect(watchOutputSize(fakeOutput(80), 'linux')).toBeUndefined()
		expect(watchOutputSize(fakeOutput(80), 'darwin')).toBeUndefined()
		expect(
			watchOutputSize(Object.assign(fakeOutput(80), { isTTY: false }), 'win32'),
		).toBeUndefined()
		expect(watchOutputSize({ isTTY: true }, 'win32')).toBeUndefined()
	})

	it('survives a console that refuses the question', () => {
		const out = fakeOutput(80)
		out._refreshSize = () => {
			throw new Error('console gone')
		}
		const stop = watchOutputSize(out, 'win32')
		expect(() => vi.advanceTimersByTime(SIZE_WATCH_INTERVAL_MS * 2)).not.toThrow()
		stop?.()
	})
})
