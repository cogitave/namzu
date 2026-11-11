import { EventEmitter } from 'node:events'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	MARKER_ONLY_PREFIX_MS,
	SHARED_PREFIX_MS,
	createPasteMarkerGuard,
	installPasteMarkerGuard,
} from './paste-marker-guard.js'

const ESC = '\u001b'
const START = `${ESC}[200~`
const END = `${ESC}[201~`

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	vi.useRealTimers()
})

/** Everything the reader gets, in order, from the guard fed by hand. */
function reader() {
	const out: string[] = []
	const guard = createPasteMarkerGuard(() => {
		const released = guard.read(null)
		if (released !== null) out.push(released)
	})
	return {
		guard,
		out,
		send(chunk: string) {
			const passed = guard.read(chunk)
			if (passed !== null) out.push(passed)
		},
		get text() {
			return out.join('')
		},
	}
}

// Every split of a marker that leaves `ESC [` or more in the first part. A split right
// after the ESC is the Escape key as far as any filter can tell (see the last block).
const splits = [START, END].flatMap((marker) =>
	[2, 3, 4, 5].map((at) => ({
		marker,
		at,
		first: marker.slice(0, at),
		second: marker.slice(at),
		// A prefix that is also Insert or an arrow waits briefly; one that is only a marker, long.
		longest: at >= 4 ? MARKER_ONLY_PREFIX_MS - 1 : SHARED_PREFIX_MS - 1,
	})),
)

describe('a paste marker split across two reads', () => {
	it.each(splits)(
		'holds $marker split after $at bytes until it is whole, however long the pause (up to its bound)',
		async ({ first, second, marker, longest }) => {
			for (const pause of [0, 21, 25, 100, longest]) {
				const r = reader()
				r.send(first)
				expect(r.out).toEqual([])
				await vi.advanceTimersByTimeAsync(pause)
				expect(r.out).toEqual([])
				r.send(second)
				expect(r.text).toBe(marker)
				expect(vi.getTimerCount()).toBe(0)
			}
		},
	)

	it.each(splits)(
		'hands a whole paste on, none of an unfinished marker early, when $marker is split after $at bytes',
		async ({ marker, first, second, longest }) => {
			const body = 'one\ntwo [x] ç'
			const parts =
				marker === START ? [first, second + body + END] : [`${START}${body}${first}`, second]
			const r = reader()
			r.send(parts[0] as string)
			await vi.advanceTimersByTimeAsync(longest)
			// Nothing of the unfinished marker has gone on; a paste body before it has.
			expect(r.text).toBe(marker === START ? '' : `${START}${body}`)
			r.send(parts[1] as string)
			expect(r.text).toBe(`${START}${body}${END}`)
		},
	)

	it('holds a prefix that is not a marker back only until the next byte shows it', () => {
		const r = reader()
		r.send(`${ESC}[2`)
		expect(r.out).toEqual([])
		r.send('~')
		expect(r.text).toBe(`${ESC}[2~`)

		const s = reader()
		s.send(`a${ESC}[20`)
		expect(s.out).toEqual(['a'])
		s.send('x')
		expect(s.text).toBe(`a${ESC}[20x`)
	})

	it('keeps text before the held prefix moving and joins a run of marker pieces', () => {
		const r = reader()
		r.send(`typed${ESC}[`)
		expect(r.out).toEqual(['typed'])
		r.send('2')
		r.send('0')
		r.send('0')
		expect(r.out).toEqual(['typed'])
		r.send(`~body${ESC}[20`)
		expect(r.text).toBe(`typed${START}body`)
		r.send('1~')
		expect(r.text).toBe(`typed${START}body${END}`)
	})

	it.each(splits)(
		'gives up on $marker split after $at bytes at its bound and hands the bytes on unchanged',
		async ({ first, longest }) => {
			const r = reader()
			r.send(first)
			await vi.advanceTimersByTimeAsync(longest)
			expect(r.out).toEqual([])
			await vi.advanceTimersByTimeAsync(1)
			expect(r.out).toEqual([first])
		},
	)
})

describe('keys that must not wait', () => {
	const keys = [
		['a lone Escape', ESC],
		['an arrow', `${ESC}[A`],
		['Alt plus a letter', `${ESC}b`],
		['Insert', `${ESC}[2~`],
		['Delete', `${ESC}[3~`],
		['a function key', `${ESC}[15~`],
		['a focus report', `${ESC}[I`],
		['a mouse report', `${ESC}[<64;10;5M`],
		['plain text', 'hello'],
	] as const

	it.each(keys)('%s arrives at once, with no timer left behind', (_name, bytes) => {
		const r = reader()
		r.send(bytes)
		expect(r.out).toEqual([bytes])
		expect(vi.getTimerCount()).toBe(0)
	})

	it('releases text that shares a read with the prefix without waiting for the prefix', () => {
		const r = reader()
		r.send(`${ESC}[A${ESC}[2`)
		expect(r.out).toEqual([`${ESC}[A`])
	})

	it('does not hold the ESC that starts a split paste: that split is the Escape key', () => {
		const r = reader()
		r.send(ESC)
		expect(r.out).toEqual([ESC])
	})
})

describe('on a stream', () => {
	class FakeStdin extends EventEmitter {
		private queue: string[] = []
		read(): string | null {
			return this.queue.shift() ?? null
		}
		push(chunk: string): void {
			this.queue.push(chunk)
			this.emit('readable')
		}
	}

	function drain(stdin: FakeStdin): string[] {
		const got: string[] = []
		for (let chunk = stdin.read(); chunk !== null; chunk = stdin.read()) got.push(chunk as string)
		return got
	}

	it('raises readable when a bound passes so the reader comes back for the held bytes', async () => {
		const stdin = new FakeStdin()
		const stop = installPasteMarkerGuard(stdin)
		const readable = vi.fn()
		stdin.on('readable', readable)
		stdin.push(`${ESC}[20`)
		expect(drain(stdin)).toEqual([])
		expect(readable).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(MARKER_ONLY_PREFIX_MS)
		expect(readable).toHaveBeenCalledTimes(2)
		expect(drain(stdin)).toEqual([`${ESC}[20`])
		stop()
	})

	it('puts the stream back the way it was', () => {
		const stdin = new FakeStdin()
		const before = stdin.read
		const stop = installPasteMarkerGuard(stdin)
		expect(stdin.read).not.toBe(before)
		stdin.push(`${ESC}[20`)
		stop()
		expect(stdin.read).toBe(before)
		expect(vi.getTimerCount()).toBe(0)
	})
})
