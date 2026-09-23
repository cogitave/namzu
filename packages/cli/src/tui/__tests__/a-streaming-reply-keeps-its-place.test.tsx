/**
 * A reply that is still streaming is drawn where it stands in the
 * conversation, not after every finalized row.
 *
 * A foreground `Agent` call leaves the parent's reply open for the whole of
 * the child's run, and the launch receipt is written meanwhile. With the reply
 * drawn last, the receipt sat above the narration that came before it, and the
 * two swapped when the turn ended. Rows written while a reply streams now go
 * below it, and nothing moves when it finishes.
 */

import { Box } from 'ink'
import { afterEach, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import type { TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

const launch: TranscriptMessage = {
	id: 'launch',
	role: 'tool',
	content: 'Launched Join the two colours',
	glyph: '●',
}
const earlier: TranscriptMessage = {
	id: 'earlier',
	role: 'tool',
	content: 'Choose second colour · 3.9s',
	glyph: '✓',
}

function narration(pending: boolean, content: string): TranscriptMessage {
	return { id: 'narration', role: 'assistant', content, pending }
}

async function draw(
	messages: readonly TranscriptMessage[],
	pending: TranscriptMessage | null,
	pendingAt?: number,
	cols = 80,
) {
	await mounted?.unmount()
	mounted = await renderToScreen(
		<Box flexDirection="column" paddingX={1}>
			<Transcript
				messages={messages}
				pending={pending}
				{...(pendingAt !== undefined ? { pendingAt } : {})}
				state="thinking"
				settled={0}
				resetKey={0}
			/>
		</Box>,
		{ cols, rows: 20 },
	)
	return mounted.viewport().filter((line) => line.trim().length > 0)
}

const order = (rows: readonly string[]) =>
	['Choose second colour', 'Phase 1 returned', 'Launched Join'].map((needle) =>
		rows.findIndex((row) => row.includes(needle)),
	)

it.each([120, 80, 40])(
	'keeps the narration above a launch written while it streamed, at %i columns',
	async (cols) => {
		const live = narration(true, 'Phase 1 returned Blue and Green;')
		const during = await draw([earlier, launch], live, 1, cols)
		const [done, text, launched] = order(during)
		expect(done).toBeGreaterThanOrEqual(0)
		expect(text).toBeGreaterThan(done)
		expect(launched).toBeGreaterThan(text)

		// Finished: the same order, so no row moved.
		const after = await draw(
			[earlier, narration(false, 'Phase 1 returned Blue and Green; starting Phase 2.'), launch],
			null,
			undefined,
			cols,
		)
		const [doneAfter, textAfter, launchedAfter] = order(after)
		expect(textAfter).toBeGreaterThan(doneAfter)
		expect(launchedAfter).toBeGreaterThan(textAfter)
	},
)

it('draws a reply with nothing after it last, as before', async () => {
	const rows = await draw([earlier], narration(true, 'Phase 1 returned Blue and Green;'), 1)
	const [done, text] = order(rows)
	expect(text).toBeGreaterThan(done)
	expect(rows.at(-1)).toContain('Phase 1 returned')
})

it('draws the reply last when the caller gives no position', async () => {
	const rows = await draw([earlier, launch], narration(true, 'Phase 1 returned Blue and Green;'))
	expect(rows.at(-1)).toContain('Phase 1 returned')
})
