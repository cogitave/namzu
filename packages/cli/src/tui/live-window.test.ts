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

import {
	LIVE_WINDOW_SAFETY_ROWS,
	MAX_LIVE_ROWS,
	checklistInView,
	estimateRenderedLines,
	liveWindow,
	transcriptLines,
} from './live-window.js'
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
		expect(split(rows(20), FURNITURE + LIVE_WINDOW_SAFETY_ROWS).settled).toBe(20)
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
		// The retained tail itself must stay below the live-region budget.
		const { rows: height } = split(rows(200), 60)
		expect(height).toBeLessThanOrEqual(60 - FURNITURE - LIVE_WINDOW_SAFETY_ROWS)
	})

	it('measures CJK in terminal cells rather than JavaScript string length', () => {
		const wide = '界'.repeat(41)
		expect(wide.length).toBe(41)
		expect(estimateRenderedLines([wide], 80)).toBe(2)
	})

	it('refuses a Markdown row whose block margins exhaust the live budget', () => {
		const blocks = Array.from({ length: 13 }, (_, i) => (i % 2 === 0 ? `# h${i}` : `p${i}`))
		const message = row({ content: blocks.join('\n') })
		expect(split([message], 40).settled).toBe(1)
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
		// Pending content is already rendered below the finalized live window.
		expect(transcriptLines([row({ pending: true, detail: ['a', 'b'] })])).toEqual([])
	})

	it('counts the whole plain body in raw mode instead of the rich collapsed projection', () => {
		const detail = Array.from({ length: 12 }, (_, i) => `raw-detail-${i + 1}`)
		const message = row({ content: '**literal**', detail, detailRef: 1 })

		const rich = transcriptLines([message])
		const raw = transcriptLines([message], true)

		expect(rich).toContain('   … 6 lines omitted · ctrl+o')
		expect(rich).toContain('   raw-detail-12')
		expect(rich).not.toContain('   raw-detail-7')
		expect(raw).toContain('raw-detail-7')
		expect(raw).toContain('raw-detail-12')
		expect(raw).not.toContain('   … 6 lines omitted · ctrl+o')
	})

	it('uses the complete raw body when bounding the redrawable window', () => {
		const messages = [
			row({
				content: 'tool output',
				detail: Array.from({ length: 30 }, (_, i) => `raw-detail-${i + 1}`),
			}),
		]
		const rich = liveWindow({
			messages,
			rows: 30,
			columns: 80,
			furnitureRows: FURNITURE,
			settled: 0,
		})
		const raw = liveWindow({
			messages,
			rows: 30,
			columns: 80,
			furnitureRows: FURNITURE,
			settled: 0,
			raw: true,
		})

		expect(rich.settled).toBe(0)
		expect(raw.settled).toBe(1)
	})
})

describe('checklistInView', () => {
	const block = (id = 'b'): TranscriptMessage =>
		row({
			id,
			role: 'system',
			content: 'Tasks · 1/2 done',
			checklist: [
				{ id: 't1', subject: 'Çalışma alanını incele', status: 'completed' },
				{ id: 't2', subject: 'Özet raporunu yaz ve dosyaya kaydet', status: 'in_progress' },
			],
			taskBlock: { key: 'k', operations: [] },
		})
	const view = (messages: TranscriptMessage[], height: number | undefined, columns = 110) =>
		checklistInView({ messages, rows: height, columns, furnitureRows: FURNITURE })

	it('is out of view when there is no checklist, or no terminal', () => {
		expect(view(rows(2), 36)).toBe(false)
		expect(view([block()], undefined)).toBe(false)
	})

	it('stays in view when a short reply follows the block', () => {
		// The owner's 110x36 frame: the block, then the closing reply under it.
		expect(
			view([row({ content: 'go' }), block(), row({ content: 'Özet dosyaya yazıldı.' })], 36),
		).toBe(true)
		expect(view([block(), row({ content: 'Done.' })], 36, 40)).toBe(true)
	})

	it('is out of view once the rows after it no longer fit', () => {
		expect(view([block(), ...rows(8)], 36)).toBe(false)
		// A screen too short for the block itself cannot show its head.
		expect(view([block()], 14)).toBe(false)
	})

	it('reads the newest block, and counts a pending row as on screen', () => {
		const older = block('old')
		expect(view([older, ...rows(8), block('new')], 36)).toBe(true)
		const pending = row({
			content: Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n'),
			pending: true,
		})
		expect(view([block(), pending], 36)).toBe(false)
	})
})
