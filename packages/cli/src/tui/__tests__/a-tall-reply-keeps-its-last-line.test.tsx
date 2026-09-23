/**
 * A reply taller than the terminal keeps its last line once it settles.
 *
 * Ink 7 takes a whole-screen repaint path once the live region reaches the
 * terminal's height, and the frame that leaves that path is recorded one row
 * taller than it was written. The next frame then erases a row of scrollback:
 * the last settled line of the reply. A real terminal lost
 * "runtime/harness mimarisi; harici bir agent framework değil." that way at
 * 160 columns and a "Kaynaklar" line at 80.
 *
 * The shape here is the transcript's: a reply streams in the live region
 * until it is taller than the screen, then settles into `<Static>` while a
 * short footer stays live, and one more frame follows (the spinner stopping,
 * the composer redrawing). The first case shows the renderer's defect on an
 * unbounded region, so the second case is proof of something.
 */

import { Box, Static, Text } from 'ink'
import { describe, expect, it } from 'vitest'

import { ViewportBound, liveRegionCap } from '../ViewportBound.js'
import { renderToScreen } from './support/screen.js'

const replyLines = (count: number) =>
	Array.from({ length: count }, (_, i) =>
		i === count - 1 ? 'harici bir agent framework değil.' : `satır ${i + 1}`,
	)

function View({
	settled,
	streaming,
	footer,
	bounded,
	rows,
}: {
	readonly settled: readonly string[]
	readonly streaming: readonly string[]
	readonly footer: string
	readonly bounded: boolean
	readonly rows: number
}) {
	const body = (
		<>
			<Static items={settled.map((text, i) => ({ text, key: `s${i}` }))}>
				{(item) => <Text key={item.key}>{item.text}</Text>}
			</Static>
			<Box flexDirection="column">
				{streaming.map((line, i) => (
					<Text key={`l${i}`}>{line}</Text>
				))}
			</Box>
			<Text>{footer}</Text>
		</>
	)
	return bounded ? (
		<ViewportBound rows={rows}>{body}</ViewportBound>
	) : (
		<Box flexDirection="column">{body}</Box>
	)
}

async function settleTallReply(bounded: boolean, cols: number) {
	const rows = 12
	const reply = replyLines(20)
	const screen = await renderToScreen(
		<View settled={['❯ soru']} streaming={[]} footer="> " bounded={bounded} rows={rows} />,
		{ cols, rows },
	)
	// Stream the reply line by line until it is taller than the screen.
	for (let n = 1; n <= reply.length; n++) {
		screen.rerender(
			<View
				settled={['❯ soru']}
				streaming={reply.slice(0, n)}
				footer="✻ Working…"
				bounded={bounded}
				rows={rows}
			/>,
		)
		await screen.waitForRender()
	}
	// It finishes: the reply goes to scrollback, the live region shrinks.
	screen.rerender(
		<View
			settled={['❯ soru', ...reply]}
			streaming={['✻ Worked for 38s']}
			footer="> "
			bounded={bounded}
			rows={rows}
		/>,
	)
	await screen.waitForRender()
	// One more frame, as the composer redraws.
	screen.rerender(
		<View
			settled={['❯ soru', ...reply]}
			streaming={['✻ Worked for 38s']}
			footer="> ▌"
			bounded={bounded}
			rows={rows}
		/>,
	)
	await screen.waitForRender()
	const all = screen.scrollback()
	const clears = screen.writes().filter((chunk) => chunk.includes('\x1b[2J')).length
	await screen.unmount()
	return { all, reply, clears }
}

describe('a reply taller than the terminal', () => {
	it('loses its last settled line when the live region is unbounded (the renderer defect)', async () => {
		const { all, reply, clears } = await settleTallReply(false, 80)
		expect(all.some((row) => row.trimEnd() === reply.at(-1))).toBe(false)
		expect(clears).toBeGreaterThan(0)
	})

	for (const cols of [40, 80, 120, 160]) {
		it(`keeps every line, the last included, inside the viewport bound at ${cols} columns`, async () => {
			const { all, reply, clears } = await settleTallReply(true, cols)
			// Never the whole-screen repaint path, which is where the row went.
			expect(clears).toBe(0)
			const text = all.map((row) => row.trimEnd())
			for (const line of reply) expect(text).toContain(line)
			// Once, and in order, directly above the closing line.
			expect(text.filter((row) => row === reply.at(-1))).toHaveLength(1)
			const last = text.indexOf(reply.at(-1) as string)
			expect(text[last + 1]).toBe('✻ Worked for 38s')
			expect(text.indexOf('satır 1')).toBeLessThan(last)
		})
	}
})

describe('liveRegionCap', () => {
	it('is one row short of the terminal, and absent when the height means nothing', () => {
		expect(liveRegionCap(24)).toBe(23)
		expect(liveRegionCap(undefined)).toBeUndefined()
		expect(liveRegionCap(Number.NaN)).toBeUndefined()
		expect(liveRegionCap(2)).toBeUndefined()
	})
})
