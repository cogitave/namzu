import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	MONITOR_BATCH_MAX_CHARS,
	MONITOR_BATCH_WINDOW_MS,
	MONITOR_LINE_MAX_CHARS,
	MONITOR_PARTIAL_LINE_MAX_BYTES,
	createMonitorStream,
	expiryNotice,
	formatMonitorDuration,
	suppressionNotice,
	tooMuchOutputNotice,
} from '../monitor-stream.js'

// Every clock here is vitest's: the window, the bucket's refill and the
// suppression rules all read `Date.now()` and `setTimeout` at call time, so
// advancing the fake clock is the only thing that moves them.

function harness() {
	const batches: string[] = []
	const notices: string[] = []
	const overflows: { suppressed: number; overMs: number }[] = []
	const stream = createMonitorStream({
		onBatch: (text) => batches.push(text),
		onNotice: (text) => notices.push(text),
		onOverflow: (info) => overflows.push(info),
	})
	return { stream, batches, notices, overflows }
}

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

describe('splitting stdout into lines', () => {
	it('joins the lines of one window into one batch, from the first line, not the last', () => {
		const h = harness()
		h.stream.push('one\n')
		vi.advanceTimersByTime(150)
		h.stream.push('two\n')
		// The window opened at the first line; a debounce would still be waiting.
		vi.advanceTimersByTime(50)
		expect(h.batches).toEqual(['one\ntwo'])
	})

	it('arms nothing until a line is complete, and joins a line split across chunks', () => {
		const h = harness()
		h.stream.push('par')
		vi.advanceTimersByTime(10_000)
		expect(h.batches).toEqual([])
		h.stream.push('tial\n')
		vi.advanceTimersByTime(MONITOR_BATCH_WINDOW_MS)
		expect(h.batches).toEqual(['partial'])
	})

	it('trims lines and drops the empty ones', () => {
		const h = harness()
		h.stream.push('  a  \r\n\n   \nb\n')
		vi.advanceTimersByTime(MONITOR_BATCH_WINDOW_MS)
		expect(h.batches).toEqual(['a\nb'])
	})

	it('keeps the first 500 characters of a longer line and says so', () => {
		const h = harness()
		h.stream.push(`${'x'.repeat(MONITOR_LINE_MAX_CHARS + 50)}\n`)
		vi.advanceTimersByTime(MONITOR_BATCH_WINDOW_MS)
		expect(h.batches).toEqual([`${'x'.repeat(MONITOR_LINE_MAX_CHARS)}...(truncated)`])
	})

	it('cuts a joined batch at 3000 characters and says so', () => {
		const h = harness()
		for (let i = 0; i < 12; i++) h.stream.push(`${String(i).padStart(2, '0')}${'y'.repeat(398)}\n`)
		vi.advanceTimersByTime(MONITOR_BATCH_WINDOW_MS)
		const batch = h.batches[0] ?? ''
		expect(batch.endsWith('\n...(truncated)')).toBe(true)
		expect(batch.length).toBe(MONITOR_BATCH_MAX_CHARS + '\n...(truncated)'.length)
	})

	it('emits a final partial line only on drain', () => {
		const h = harness()
		h.stream.push('done\nno newline')
		vi.advanceTimersByTime(MONITOR_BATCH_WINDOW_MS)
		expect(h.batches).toEqual(['done'])
		h.stream.drain()
		expect(h.batches).toEqual(['done', 'no newline'])
	})

	it('drain flushes a pending batch without waiting for its window', () => {
		const h = harness()
		h.stream.push('a\nb\n')
		h.stream.drain()
		expect(h.batches).toEqual(['a\nb'])
		// The timer was cleared, so nothing fires a second time.
		vi.advanceTimersByTime(10_000)
		expect(h.batches).toEqual(['a\nb'])
	})

	it('keeps the tail of a partial line that never ends', () => {
		const h = harness()
		h.stream.push('a'.repeat(MONITOR_PARTIAL_LINE_MAX_BYTES))
		h.stream.push('TAIL')
		h.stream.drain()
		const line = h.batches[0] ?? ''
		// The line is then cut to its own cap; what matters is that it is the
		// tail of the stream that survived the buffer, not the head.
		expect(h.batches).toHaveLength(1)
		expect(line.startsWith('a')).toBe(true)
		expect(h.stream.stats().stdoutChars).toBe(MONITOR_PARTIAL_LINE_MAX_BYTES + 4)
	})

	it('counts every character pushed, whatever it does with them', () => {
		const h = harness()
		h.stream.push('\n\n   \n')
		expect(h.stream.stats()).toEqual({ eventsDelivered: 0, suppressed: 0, stdoutChars: 6 })
	})
})

/**
 * The bucket refills with the clock, and a real window passing also moves the
 * clock, so a test that drove both through fake timers would be asserting
 * floating-point refill at its boundaries. The rationing tests therefore own
 * the clock outright and fire the window by hand: a batch costs no time here,
 * and time passes only when the test says so.
 */
function ration() {
	let clock = 1_000_000
	let pending: (() => void) | undefined
	const batches: string[] = []
	const notices: string[] = []
	const overflows: { suppressed: number; overMs: number }[] = []
	const stream = createMonitorStream({
		onBatch: (text) => batches.push(text),
		onNotice: (text) => notices.push(text),
		onOverflow: (info) => overflows.push(info),
		now: () => clock,
		setTimer: (callback) => {
			pending = callback
			return 1
		},
		clearTimer: () => {
			pending = undefined
		},
	})
	return {
		stream,
		batches,
		notices,
		overflows,
		clock: () => clock,
		advance: (ms: number) => {
			clock += ms
		},
		batch: (text: string) => {
			stream.push(`${text}\n`)
			const fire = pending
			pending = undefined
			fire?.()
		},
	}
}

describe('rationing batches', () => {
	it('delivers ten batches at once, then drops the eleventh', () => {
		const r = ration()
		for (let i = 0; i < 11; i++) r.batch(`line ${i}`)
		expect(r.batches).toHaveLength(10)
		expect(r.stream.stats().suppressed).toBe(1)
	})

	it('refills one token per two seconds', () => {
		const r = ration()
		for (let i = 0; i < 11; i++) r.batch(`line ${i}`)
		r.advance(1999)
		r.batch('too soon')
		expect(r.batches.at(-1)).not.toBe('too soon')
		r.advance(1)
		r.batch('after refill')
		expect(r.batches.at(-1)).toBe('after refill')
	})

	it('announces what was suppressed before the next batch that gets a token', () => {
		const r = ration()
		for (let i = 0; i < 13; i++) r.batch(`line ${i}`)
		expect(r.stream.stats().suppressed).toBe(3)
		expect(r.notices).toEqual([])
		r.advance(2000)
		r.batch('later')
		expect(r.notices).toEqual([suppressionNotice(3)])
		expect(r.batches.at(-1)).toBe('later')
		// Said once: the next batch is not preceded by it again.
		r.advance(2000)
		r.batch('again')
		expect(r.notices).toHaveLength(1)
		expect(r.batches.at(-1)).toBe('again')
	})

	it('stops the source when suppression began over 30 s ago and another batch is dropped', () => {
		const r = ration()
		for (let i = 0; i < 11; i++) r.batch(`line ${i}`) // drop #1 starts the tracker
		const began = r.clock()
		expect(r.overflows).toEqual([])
		// A batch every 250 ms earns an eighth of a token each, so most are
		// dropped and one in eight gets through; the stop comes on a DROP once the
		// tracker is more than 30 s old, never before.
		let elapsed = 0
		while (r.overflows.length === 0 && elapsed < 60_000) {
			r.advance(250)
			elapsed += 250
			r.batch(`flood ${elapsed}`)
			if (r.overflows.length === 0) expect(r.clock() - began).toBeLessThanOrEqual(30_000)
		}
		expect(r.overflows).toHaveLength(1)
		expect(r.overflows[0]?.overMs).toBeGreaterThan(30_000)
		expect(r.overflows[0]?.overMs).toBe(r.clock() - began)
		expect(r.overflows[0]?.suppressed).toBeGreaterThan(50)
		// Closed: nothing more is delivered, and no second overflow.
		const delivered = r.batches.length
		r.advance(10_000)
		r.batch('after stop')
		r.stream.drain()
		expect(r.batches).toHaveLength(delivered)
		expect(r.overflows).toHaveLength(1)
	})

	it('does not stop a source whose suppression is shorter than 30 s', () => {
		const r = ration()
		for (let i = 0; i < 11; i++) r.batch(`line ${i}`)
		for (let i = 0; i < 20; i++) {
			r.advance(500)
			r.batch(`burst ${i}`)
		}
		expect(r.overflows).toEqual([])
	})

	it('forgets a suppression only after a notice went out and the source was quiet for 6 s', () => {
		const r = ration()
		for (let i = 0; i < 12; i++) r.batch(`line ${i}`) // 2 dropped
		r.advance(2000)
		r.batch('notice carrier') // earns a token, so the notice is emitted
		expect(r.notices).toHaveLength(1)
		// Quiet for well over 6 s, then dropped batches again: the tracker has
		// reset, so suppression "began" just now and 30 s have not passed.
		r.advance(40_000)
		for (let i = 0; i < 12; i++) r.batch(`second burst ${i}`)
		expect(r.overflows).toEqual([])
		r.advance(20_000)
		r.batch('still fine')
		expect(r.overflows).toEqual([])
	})

	it('keeps the tracker when a notice went out but the source never went quiet', () => {
		const r = ration()
		for (let i = 0; i < 11; i++) r.batch(`line ${i}`) // tracker starts here
		const began = r.clock()
		r.advance(2000)
		r.batch('notice carrier')
		expect(r.notices).toHaveLength(1)
		// Dropped again within 6 s of the last drop, so no reset: the stop is
		// measured from the FIRST drop, not from the notice.
		let guard = 0
		while (r.overflows.length === 0 && guard++ < 400) {
			r.advance(250)
			r.batch(`burst ${guard}`)
		}
		expect(r.overflows).toHaveLength(1)
		expect(r.overflows[0]?.overMs).toBe(r.clock() - began)
	})
})

describe('closing', () => {
	it('close discards what is pending and silences the stream', () => {
		const h = harness()
		h.stream.push('a\n')
		h.stream.close()
		vi.advanceTimersByTime(10_000)
		h.stream.push('b\n')
		h.stream.drain()
		expect(h.batches).toEqual([])
	})

	it('flush emits the pending batch but not the partial line', () => {
		const h = harness()
		h.stream.push('whole\npartial')
		h.stream.flush()
		expect(h.batches).toEqual(['whole'])
	})

	it('an injected clock and timer replace the globals', () => {
		const fired: (() => void)[] = []
		let at = 0
		const batches: string[] = []
		const stream = createMonitorStream({
			onBatch: (t) => batches.push(t),
			onNotice: () => {},
			onOverflow: () => {},
			now: () => at,
			setTimer: (cb) => {
				fired.push(cb)
				return fired.length
			},
			clearTimer: () => {},
		})
		stream.push('x\n')
		expect(batches).toEqual([])
		at += MONITOR_BATCH_WINDOW_MS
		fired[0]?.()
		expect(batches).toEqual(['x'])
	})
})

describe('the words', () => {
	it('formats a duration as whole minutes or seconds', () => {
		expect(formatMonitorDuration(1_800_000)).toBe('30m')
		expect(formatMonitorDuration(300_000)).toBe('5m')
		expect(formatMonitorDuration(90_000)).toBe('90s')
		expect(formatMonitorDuration(1000)).toBe('1s')
	})

	it('says what the reference says, in our own tool names', () => {
		expect(suppressionNotice(4)).toBe(
			'[4 events suppressed — output rate too high. Consider stopping this monitor and starting it with a more selective command.]',
		)
		expect(tooMuchOutputNotice(40, 35_000)).toBe(
			'[Monitor stopped — too much output (40 events suppressed over 35s). Restart it with a more selective command.]',
		)
		expect(expiryNotice(1_800_000, 3)).toBe(
			'[Monitor expired after 30m with 3 events delivered. Start it again if you still need the watch.]',
		)
		expect(expiryNotice(300_000, 0)).toBe(
			'[Monitor expired after 5m with no events delivered. Start it again if you still need the watch — and widen the filter if silence was unexpected.]',
		)
	})
})
