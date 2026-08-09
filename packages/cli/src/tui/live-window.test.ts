/**
 * How much of the transcript stays redrawable.
 *
 * The window's whole job is to be SMALL — small enough that the live region
 * never reaches the viewport's height, because at that point the renderer stops
 * repainting incrementally and rewrites the entire session's static output on
 * every frame. So most of what is asserted here is a refusal: no terminal, a
 * short terminal, a row taller than the budget, a floor already past the end.
 */

import { describe, expect, it } from 'vitest'

import { SAFETY_ROWS } from './bottom-spacer.js'
import { MAX_LIVE_ROWS, liveWindow, transcriptLines } from './live-window.js'
import type { TranscriptMessage } from './types.js'

const FURNITURE = 10

function row(over: Partial<TranscriptMessage> = {}): TranscriptMessage {
	return { id: 'm1', role: 'assistant', content: 'a short line', ...over }
}

function rows(n: number): TranscriptMessage[] {
	return Array.from({ length: n }, (_, i) => row({ id: `m${i}`, content: `line ${i}` }))
}

function split(
	messages: readonly TranscriptMessage[],
	terminalRows: number | undefined,
	settled = 0,
) {
	return liveWindow({
		messages,
		rows: terminalRows,
		columns: 80,
		furnitureRows: FURNITURE,
		settled,
	})
}

describe('liveWindow', () => {
	it('holds nothing when there is no terminal to measure', () => {
		// Piped output. Nothing is being redrawn, so nothing gains from staying
		// live, and the height that would bound it is unknown.
		expect(split(rows(20), undefined).settled).toBe(20)
	})

	it('holds nothing on a terminal with no room to spare', () => {
		// Furniture plus the safety margin already exceed the height, so the
		// budget is negative and the window is empty — which is exactly the
		// behaviour before there was a window.
		expect(split(rows(20), FURNITURE + SAFETY_ROWS).settled).toBe(20)
	})

	it('holds the most recent rows on a terminal with room', () => {
		const { settled } = split(rows(20), 60)
		expect(settled).toBeLessThan(20)
		expect(20 - settled).toBeGreaterThan(0)
	})

	it('never holds more than the cap, however tall the terminal', () => {
		// The budget alone would put thirty short rows in the live region on a
		// tall screen: thirty rows re-laid-out per spinner tick to make expansion
		// available on output nobody is looking at.
		const { settled } = split(rows(200), 400)
		expect(200 - settled).toBe(MAX_LIVE_ROWS)
	})

	it('holds fewer rows when the rows are taller', () => {
		// The bound is height, not count. Two transcripts of the same length hold
		// different numbers of rows, and the tall one holds fewer.
		const short = split(rows(20), 60)
		const tall = split(
			Array.from({ length: 20 }, (_, i) =>
				row({
					id: `m${i}`,
					content: `line ${i}`,
					detail: Array.from({ length: 40 }, (_, j) => `d${j}`),
					detailExpanded: true,
				}),
			),
			60,
		)
		expect(20 - tall.settled).toBeLessThan(20 - short.settled)
	})

	it('holds nothing when even the most recent row is taller than the budget', () => {
		// A two-hundred-line expanded body. Refusing is the safe direction: the
		// operator loses retroactive expansion of that row and keeps the session.
		const huge = [
			...rows(3),
			row({
				id: 'big',
				detail: Array.from({ length: 200 }, (_, i) => `d${i}`),
				detailExpanded: true,
			}),
		]
		expect(split(huge, 40).settled).toBe(huge.length)
	})

	it('keeps the live region inside the budget it was given', () => {
		// The number handed to the spacer as `liveRows`, which is what stops the
		// composer being padded into a live region that is already full.
		const { rows: height } = split(rows(200), 60)
		expect(height).toBeLessThanOrEqual(60 - FURNITURE - SAFETY_ROWS)
	})

	it('never reaches back past what has already been printed', () => {
		// The monotonic floor. `<Static>` counts what it has emitted and renders
		// only past that count, so a window that reopened a printed row would
		// leave later rows unprinted — and the row itself would be drawn twice.
		const messages = rows(20)
		const wide = split(messages, 400)
		expect(20 - wide.settled).toBe(MAX_LIVE_ROWS)

		const floored = split(messages, 400, 19)
		expect(floored.settled).toBe(19)
		expect(20 - floored.settled).toBe(1)
	})

	it('is idempotent, so a repeated render reaches the same split', () => {
		// It runs during render and writes its answer back to a ref. React may
		// render the same state twice; the second pass has to agree with the
		// first or the window would creep shut a row at a time.
		const messages = rows(20)
		const once = split(messages, 60)
		const twice = split(messages, 60, once.settled)
		expect(twice.settled).toBe(once.settled)
		expect(twice.rows).toBe(once.rows)
	})
})

describe('transcriptLines', () => {
	it('leaves out the row still streaming, which is not in the static log yet', () => {
		// The live region is covered by the spacer's `liveRows`, so counting a
		// pending row here would count it twice.
		expect(transcriptLines([row({ pending: true, detail: ['a', 'b'] })])).toEqual([])
	})
})
