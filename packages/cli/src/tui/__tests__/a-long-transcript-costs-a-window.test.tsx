/**
 * A live window costs the window, not the transcript.
 *
 * This is the risk in keeping any finalized rows redrawable, and it is the one
 * the previous design paid `<Static>` to remove: the whole transcript was once
 * re-rendered on every spinner tick, which exhausted memory on long sessions.
 * The claim being made now is that the incident was **allocation churn** rather
 * than retention — the transcript is held in component state either way, so
 * what a window adds is a few rows of rendered output and what it must not add
 * is per-frame work proportional to the session.
 *
 * ## Why the numbers are per frame, and measured at two lengths
 *
 * An assertion like "expansion works" would pass for an implementation that
 * keeps every row live, which is the failure this file exists to catch. So what
 * is measured is the cost of ONE frame: inline re-parses, which is real render
 * work, and bytes written, which is what the renderer actually put on the wire.
 *
 * Both are measured at a hundred rows and at a thousand. One length cannot tell
 * "bounded" from "small so far" — the two answers differ by a factor of ten
 * only when the lengths do.
 *
 * ## Why the frames are driven rather than waited for
 *
 * The incident names the spinner, and the spinner is a timer — so the obvious
 * harness lets half a second of ticks go by and divides. That was the first
 * version of this file and it was too blunt to see anything: the renderer emits
 * several stdout chunks per frame, so dividing by chunks diluted a window of
 * six rows re-rendering into "2.3 per frame", which sat comfortably under every
 * bound. Removing the memo changed nothing a reader could see.
 *
 * A token arriving re-renders this component exactly as a spinner tick does, so
 * the frames are driven one at a time instead, each awaited. The denominator is
 * then a number this file chose rather than one the machine's load decided, and
 * there is no duration anywhere in it.
 */

import { describe, expect, it, vi } from 'vitest'

import { liveWindow } from '../live-window.js'
import type { TranscriptMessage } from '../types.js'
import { renderToScreen } from './support/screen.js'

/** Real render work, counted where it happens. */
let inlineCalls = 0
vi.mock('../markdownParser.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../markdownParser.js')>()
	return {
		...actual,
		parseInline: (text: string) => {
			inlineCalls++
			return actual.parseInline(text)
		},
	}
})

const { Transcript } = await import('../Transcript.js')

const TERMINAL_ROWS = 60
const TERMINAL_COLS = 80
const FURNITURE = 10

function transcript(n: number): TranscriptMessage[] {
	return Array.from({ length: n }, (_, i) => ({
		id: `m${i}`,
		role: 'assistant' as const,
		content: `turn ${i}: a reply with **bold** and \`code\` in it`,
	}))
}

/** The reply being streamed, after `tokens` of it have arrived. */
function pendingAfter(tokens: number): TranscriptMessage {
	return {
		id: 'pending',
		role: 'assistant',
		content: `still writing${' more'.repeat(tokens)}`,
		pending: true,
	}
}

/** Frames driven, so the denominator is not a guess about the machine. */
const FRAMES = 8

interface FrameCost {
	readonly inlinePerFrame: number
	readonly bytesPerFrame: number
	readonly live: number
}

/** Mount a transcript of `n` rows and measure what one frame of streaming costs. */
async function costPerFrame(n: number): Promise<FrameCost> {
	const messages = transcript(n)
	// The production split, so a change to the window's bounds reaches this
	// test rather than being reproduced by it.
	const { settled } = liveWindow({
		messages,
		rows: TERMINAL_ROWS,
		columns: TERMINAL_COLS,
		furnitureRows: FURNITURE,
		settled: 0,
	})
	const view = (tokens: number) => (
		<Transcript
			messages={messages}
			pending={pendingAfter(tokens)}
			// Idle, so the only thing re-rendering this component is the token
			// below. A running spinner would add frames on a timer, and the
			// measurement would be back to dividing by a number the machine chose.
			state="idle"
			settled={settled}
			resetKey={0}
		/>
	)
	const screen = await renderToScreen(view(0), {
		cols: TERMINAL_COLS,
		rows: TERMINAL_ROWS,
		scrollback: 200,
	})
	try {
		// Everything before this point is the one-off cost of printing the
		// backlog into scrollback, which is not what is being measured.
		const fromBytes = screen.bytesWritten()
		const fromInline = inlineCalls
		for (let i = 1; i <= FRAMES; i++) {
			screen.rerender(view(i))
			await screen.waitForRender()
		}
		return {
			inlinePerFrame: (inlineCalls - fromInline) / FRAMES,
			bytesPerFrame: (screen.bytesWritten() - fromBytes) / FRAMES,
			live: messages.length - settled,
		}
	} finally {
		await screen.unmount()
	}
}

describe('a session with a thousand rows', () => {
	it('costs the same per frame as one with a hundred', async () => {
		const hundred = await costPerFrame(100)
		const thousand = await costPerFrame(1000)

		// It is a window rather than the whole transcript, and rather than
		// nothing — "bounded" asserted about an empty set is not an assertion,
		// and neither of the numbers below can discriminate if the window holds
		// one row.
		expect(hundred.live, 'nothing was kept live, so nothing is being bounded').toBeGreaterThan(2)
		expect(thousand.live).toBe(hundred.live)

		// Render work per frame: the row being written, and nothing else. The
		// finalized rows in the window are unchanged objects between frames, so
		// the memo on them holds; without it this is one per windowed row.
		expect(
			thousand.inlinePerFrame,
			`inline re-parses per frame: ${hundred.inlinePerFrame.toFixed(1)} at a hundred rows, ${thousand.inlinePerFrame.toFixed(1)} at a thousand`,
		).toBeLessThan(hundred.inlinePerFrame + 1)
		expect(
			thousand.inlinePerFrame,
			'a frame re-rendered more than the row that changed',
		).toBeLessThan(2)

		// Bytes per frame: what the renderer actually wrote. This is the memory
		// argument made checkable — the failure being guarded against is the
		// renderer giving up on incremental repaint and rewriting the session.
		expect(
			thousand.bytesPerFrame,
			`bytes per frame: ${Math.round(hundred.bytesPerFrame)} at a hundred rows, ${Math.round(thousand.bytesPerFrame)} at a thousand`,
		).toBeLessThan(hundred.bytesPerFrame * 1.5 + 200)
	}, 30_000)

	it('leaves the transcript in scrollback rather than taking the alternate screen', async () => {
		// A window that redraws rows must not be a window that owns the screen:
		// everything behind it still has to survive where the operator scrolls.
		const messages = transcript(100)
		const { settled } = liveWindow({
			messages,
			rows: TERMINAL_ROWS,
			columns: TERMINAL_COLS,
			furnitureRows: FURNITURE,
			settled: 0,
		})
		const screen = await renderToScreen(
			<Transcript
				messages={messages}
				pending={null}
				state="idle"
				settled={settled}
				resetKey={0}
			/>,
			{ cols: TERMINAL_COLS, rows: TERMINAL_ROWS, scrollback: 400 },
		)
		try {
			expect(screen.bufferType()).toBe('normal')
			const all = screen.scrollback().join('\n')
			expect(all, 'a row that scrolled away was never printed').toContain('turn 10:')
			// And exactly once — a row handed from the window to scrollback must
			// not be printed a second time on the way out.
			const printed = screen.scrollback().filter((line) => line.includes('turn 10:'))
			expect(printed, 'a row was printed twice').toHaveLength(1)
		} finally {
			await screen.unmount()
		}
	}, 30_000)
})
