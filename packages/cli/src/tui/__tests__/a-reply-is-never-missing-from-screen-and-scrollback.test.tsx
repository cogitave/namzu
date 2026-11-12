/**
 * While a reply is written, nothing of it is missing from both the screen and
 * the scrollback, at a tall window and at a short one.
 *
 * The live part is capped to the window and clipped at its top, so a reply
 * that stayed in it lost its first rows (and the person's own message above
 * it) until the turn ended. Finished blocks are printed instead, and the
 * message row and everything before the reply are printed before it starts.
 */

import { Box } from 'ink'
import { afterEach, expect, it } from 'vitest'

import { Transcript } from '../Transcript.js'
import { freezeMore } from '../stream-flow.js'
import type { PrintedChunk, TranscriptMessage } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

let mounted: Screen | undefined
afterEach(async () => {
	await mounted?.unmount()
	mounted = undefined
})

const REPLY = [
	'## First heading',
	'',
	'A first paragraph that is long enough to wrap on a short window, with `code` and **bold** in it.',
	'',
	'- one item',
	'- another item',
	'',
	'```ts',
	...Array.from({ length: 30 }, (_, i) => `const line${i} = ${i}`),
	'```',
	'',
	'| a | b |',
	'|---|---|',
	'| 1 | 2 |',
	'',
	'The closing paragraph.',
].join('\n')

const USER: TranscriptMessage = { id: 'u', role: 'user', content: 'the question asked' }

it.each([
	[120, 40],
	[80, 24],
])('at %i by %i', async (cols, rows) => {
	const ctx = { freeze: true, width: cols - 4, rows, hyperlinks: false }
	let printed: readonly PrintedChunk[] = []
	for (let end = 1; end <= REPLY.length; end += 37) {
		const content = REPLY.slice(0, end)
		printed = freezeMore(content, printed, ctx) ?? printed
		const pending: TranscriptMessage = {
			id: 'r',
			role: 'assistant',
			content,
			pending: true,
			printed,
		}
		await mounted?.unmount()
		mounted = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<Transcript
					messages={[USER]}
					pending={pending}
					pendingAt={1}
					state="thinking"
					settled={1}
					resetKey={0}
					staticIndent={1}
				/>
			</Box>,
			{ cols, rows },
		)
		const everything = mounted.scrollback().join('\n')
		expect(everything, `question at ${end}`).toContain('the question asked')
		// Every finished heading, item and code line that has been printed is somewhere.
		for (const chunk of printed) {
			for (const word of chunk.text.match(/const line\d+|First heading|another item/gu) ?? []) {
				expect(everything, `"${word}" at ${end}`).toContain(word)
			}
		}
		// And none of it twice.
		expect(everything.split('First heading').length - 1).toBeLessThanOrEqual(1)
	}
})
