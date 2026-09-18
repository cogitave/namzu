/**
 * The picker at the sizes a real terminal has, not the one a test picked.
 *
 * Every test in this directory that renders the picker renders it at 100
 * columns with room to spare, which is why none of them saw the four defects a
 * PTY run found on a 60x20 terminal: a row two columns wider than the area it
 * was measured against, a cursor row that lost the space beside its marker, a
 * box taller than the screen it was drawn on, and a sentence that repeated a
 * word the row already carried. Each is reproduced here at the size where it
 * fails, and each fails against the sources that had it.
 *
 * ## The inset is part of the fixture
 *
 * `HOST_INSET` below is the app's own: `App.tsx` draws every screen inside a
 * box with one column of padding on each side, so the picker's box is two
 * columns narrower than the terminal. The rendering tests that missed the width
 * defect rendered the picker with no host at all, which is a screen that does
 * not ship — the whole reason `pickerContentWidth` subtracts six and not four.
 */

import { Box } from 'ink'
import { afterEach, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { Picker, pickerContentWidth } from '../Picker.js'
import { wrapChoiceText } from '../terminal-choice-text.js'
import { type Screen, renderToScreen } from './support/screen.js'

const HOST_INSET = 1

/** The row that loses its spacing when it is squeezed, verbatim from the capture. */
const KEY_LOST_AT_60 = 'needs DEEPSEEK_API_KEY'

const NOTICE =
	'No credential found for DeepSeek, your saved provider. namzu looked for DEEPSEEK_API_KEY and found none. Enter one below with "k", or choose a different provider.'

function detected(): readonly DetectedProvider[] {
	return [
		{
			entry: PROVIDER_REGISTRY.ollama,
			source: { kind: 'probe', url: 'http://localhost:11434' },
			alternatives: [],
		},
		{
			entry: PROVIDER_REGISTRY.openrouter,
			source: { kind: 'env', envName: 'OPENROUTER_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		},
	]
}

let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

/** Render the picker the way the app does: inside its one-column inset. */
async function open(
	cols: number,
	rows: number,
	overrides: Partial<Parameters<typeof Picker>[0]> = {},
): Promise<Screen> {
	const screen = await renderToScreen(
		<Box paddingX={HOST_INSET}>
			<Picker
				detected={detected()}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
				onCredential={vi.fn()}
				keyEntryFor="deepseek"
				notice={NOTICE}
				{...overrides}
			/>
		</Box>,
		{ cols, rows },
	)
	mounted = screen
	await screen.waitForRender()
	return screen
}

/** Lines beginning with a row number, which is what the list is made of. */
function rowLines(screen: Screen): string[] {
	return screen.viewport().filter((line) => /│ [› ] \d+\. /.test(line))
}

it('measures the content area it actually has, not two columns more', async () => {
	// Derived from the box on screen rather than restated: the border line is
	// the width the box really has, and the text area inside it is that minus
	// the two borders and the two padding columns.
	const columns = 60
	const screen = await open(columns, 20)
	const border = screen.viewport().find((line) => line.includes('╭'))
	expect(border, 'no box was drawn').toBeDefined()
	const interior = (border ?? '').length - HOST_INSET - 2

	expect(interior - 2).toBe(pickerContentWidth(columns))
	expect(pickerContentWidth(columns)).toBe(columns - 6)
})

it('keeps a model row on one line at 60 columns', async () => {
	// The defect, in the words of the terminal: the row was measured against 56
	// columns and drawn in 54, so the note beside the model it had just marked
	// `(current)` wrapped onto a line of its own.
	//
	// The name is 40 columns on purpose. With the prefix `❯ 1. ` and the note
	// `(current)` that is a row of 55 columns: it fits the wrong area and not the
	// real one, so this is the one column where the two arithmetics disagree.
	const id = 'nvidia/nemotron-3.5-lightning:free'
	const screen = await open(60, 20, {
		keyEntryFor: null,
		notice: null,
		describeModels: async () => ({
			kind: 'ok',
			models: [
				{
					id,
					name: 'NVIDIA: Nemotron 3.5 Lightning (free) XY',
					inputPrice: 0,
					outputPrice: 0,
				},
			],
		}),
		currentModel: id,
	})
	// The cursor starts on the detected vendor, whose one way in is its models.
	screen.press('\r')
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('Search:')
	})

	// One line carries `(current)`, and the name is on it: the screen truncates a
	// row that does not fit rather than letting the renderer wrap it.
	const current = screen.viewport().filter((line) => line.includes('(current)'))
	expect(current).toHaveLength(1)
	expect(current[0]).toContain('NVIDIA: Nemotron 3.5')
})

it('keeps the space between the cursor marker and the row number', async () => {
	// `›6. DeepSeek` was the capture. A row is squeezed by the renderer only when
	// it is wider than the box's content area — measured in a sweep from 51 to 56
	// columns at 60: at 54 the spaces are kept, at 55 the marker loses its. So
	// this fixture is a row that would be wider: the source is 30 columns, more
	// than the 21 the row has left for it after the marker, number, padded name
	// and the gap that precedes them.
	const screen = await open(60, 20, {
		keyEntryFor: null,
		notice: null,
		detected: [
			{
				entry: PROVIDER_REGISTRY.openrouter,
				source: { kind: 'env', envName: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' },
				apiKey: 'not-a-real-key',
				alternatives: [],
			},
		],
	})
	const lines = screen.viewport()
	const at = lines.findIndex((line) => line.includes('›'))
	const cursorRow = lines[at] ?? ''
	// What is between the borders the box drew. The viewport trims a row's
	// trailing blanks, so this is the text the row actually ends with.
	const rowText = cursorRow.replace(/^[^│]*│/, '').replace(/│[^│]*$/, '')

	// The marker kept its space.
	expect(cursorRow).toContain(`› ${rowNumberOf(cursorRow)}. OpenRouter`)
	// And the row is inside the area, so nothing had to be squeezed: the source
	// was wrapped by the screen rather than allowed to run past the border.
	expect(rowText.trimEnd().length).toBeLessThanOrEqual(54)
	expect(rowText).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ')

	expect(cursorRow).toContain(`› ${rowNumberOf(cursorRow)}. OpenRouter`)
})

it('draws the notice and the title at 60x20 instead of scrolling them away', async () => {
	// The box used to be as tall as its rows wanted, so on a 20-row terminal Ink
	// scrolled it and the first visible line was the tail of a row. Watched from
	// the top: the notice is what says why this screen is open.
	const screen = await open(60, 20)
	const viewport = screen.viewport().join('\n')

	expect(viewport).toContain('Choose a provider')
	expect(viewport).toContain('No credential found for DeepSeek')
	expect(viewport).toContain('Enter one below with "k"')
})

it('wraps its own sentences so no continuation starts one column in', async () => {
	// Ink's wrapping keeps the space it broke at, so the notice's second line
	// began with it and the paragraph's left edge was ragged inside a box that
	// exists to have a straight one.
	const lines = wrapChoiceText(NOTICE, 54)

	expect(lines.length).toBeGreaterThan(1)
	expect(lines.every((line) => !line.startsWith(' '))).toBe(true)
	expect(lines.join(' ').replace(/\s+/g, ' ')).toBe(NOTICE)
})

it('says what esc does where there is nothing behind the picker', async () => {
	const exiting = await open(80, 24, { cancelExits: true })
	expect(exiting.viewport().join('\n')).toContain('esc exit namzu')

	const staying = await open(80, 24)
	expect(staying.viewport().join('\n')).toContain('esc cancel')
})

/** The number the cursor row printed, so the assertion is about its spacing. */
function rowNumberOf(line: string): string {
	return /› (\d+)\./.exec(line)?.[1] ?? '?'
}
