/**
 * The key line of the provider picker is one row at every width, and a list
 * that does not fit says how many rows it left out.
 *
 * Found in a real narrow terminal: the no-key picker's last line ("… esc or
 * ctrl+c exit") wrapped onto a second row at 116 columns, a third at 50, and at
 * 50 columns by 30 rows the list showed three of its seven providers without
 * a word about the other four. Both are drawn here at the sizes a person's
 * terminal and split pane really have, and the assertions read the screen the
 * way a person does.
 */

import { Box } from 'ink'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DetectedProvider } from '../../integrations/providers/index.js'
import { PROVIDER_REGISTRY } from '../../integrations/providers/index.js'
import { Picker } from '../Picker.js'
import { type Screen, renderToScreen } from './support/screen.js'

const WIDTHS = [40, 50, 60, 80, 116, 160] as const
const HEIGHTS = [24, 30] as const
const SEVEN_VENDORS = 7

const NOTICE =
	'No API key found for Anthropic (Claude), your saved provider. Namzu looked for ANTHROPIC_API_KEY, ANTHROPIC_TOKEN, CLAUDE_CODE_OAUTH_TOKEN and found none. Choose “Enter an API key” below, or pick another provider.'

function zenOnly(): readonly DetectedProvider[] {
	return [
		{
			entry: PROVIDER_REGISTRY.zen,
			source: { kind: 'public' },
			alternatives: [],
		},
	]
}

let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

async function open(
	cols: number,
	rows: number,
	detected: readonly DetectedProvider[],
	overrides: Partial<Parameters<typeof Picker>[0]> = {},
): Promise<Screen> {
	const screen = await renderToScreen(
		<Box paddingX={1}>
			<Picker
				detected={detected}
				onSubmit={vi.fn()}
				onCancel={vi.fn()}
				onCredential={vi.fn()}
				onLogin={vi.fn()}
				onSetup={vi.fn()}
				keyEntryFor="anthropic"
				cancelExits
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

/** The text of a box line, borders and padding removed. */
function inside(line: string): string {
	return line
		.replace(/^\s*│ ?/, '')
		.replace(/ ?│\s*$/, '')
		.trimEnd()
}

/** The line directly above the bottom border, and the one above that. */
function lastTwoLines(screen: Screen): { key: string; above: string } {
	const lines = screen.viewport()
	const bottom = lines.findIndex((line) => line.includes('╰'))
	expect(bottom, 'the box has no bottom border on screen').toBeGreaterThan(1)
	return { key: inside(lines[bottom - 1] ?? ''), above: inside(lines[bottom - 2] ?? '') }
}

describe('the picker key line', () => {
	it.each(WIDTHS.flatMap((cols) => HEIGHTS.map((rows) => [cols, rows] as const)))(
		'is one row at %i columns by %i rows, with no hint cut in the middle',
		async (cols, rows) => {
			const screen = await open(cols, rows, zenOnly())
			const { key, above } = lastTwoLines(screen)
			// One row: the row above it is the blank that separates it from the list.
			expect(above, 'the key line took more than one row').toBe('')
			// The keys that leave the screen are the last to go.
			expect(key).toContain('↑↓')
			expect(key).toContain('select')
			expect(key).toContain('enter apply')
			expect(key).toMatch(/esc( or ctrl\+c)? exit/)
			// Every hint is whole: the pieces between the separators are known words.
			for (const hint of key.split(' · ')) {
				expect(hint).toMatch(
					/^(↑↓( or 1–9)? select|enter apply|k (enter an )?API key|l (create a Namzu )?sign-in|s (provider )?setup|esc( or ctrl\+c)? exit)$/,
				)
			}
		},
	)

	it('is one row on the screen with nothing detected, too', async () => {
		for (const cols of WIDTHS) {
			const screen = await open(cols, 30, [])
			const { key, above } = lastTwoLines(screen)
			expect(above, `wrapped at ${cols} columns`).toBe('')
			expect(key).toContain('select')
			expect(key).toMatch(/esc( or ctrl\+c)? exit/)
			await screen.unmount()
			mounted = null
		}
	})

	it('keeps every hint when the line has room for them', async () => {
		const screen = await open(160, 30, zenOnly())
		const { key } = lastTwoLines(screen)
		expect(key).toBe(
			'↑↓ or 1–9 select · enter apply · k enter an API key · l create a Namzu sign-in · s provider setup · esc or ctrl+c exit',
		)
	})
})

describe('a list that does not fit', () => {
	/** The provider rows on screen, by their number. */
	function numbers(screen: Screen): number[] {
		return screen
			.viewport()
			.map((line) => /│ [› ] (\d+)\. /.exec(line)?.[1])
			.filter((n): n is string => n !== undefined)
			.map(Number)
	}

	/** What is on screen is contiguous, the cursor is in it, and each cut side is counted. */
	function expectWindowSaysWhatIsHidden(screen: Screen): void {
		const shown = numbers(screen)
		const view = screen.viewport().join('\n')
		expect(shown.length).toBeGreaterThan(0)
		expect(shown.length).toBe(Math.max(...shown) - Math.min(...shown) + 1)
		expect(view).toMatch(/│ › \d+\. /)
		const above = Math.min(...shown) - 1
		const below = SEVEN_VENDORS - Math.max(...shown)
		if (above > 0) expect(view).toContain(`↑ ${above} more`)
		else expect(view).not.toMatch(/↑ \d+ more/)
		if (below > 0) expect(view).toContain(`↓ ${below} more`)
		else expect(view).not.toMatch(/↓ \d+ more/)
	}

	it.each(WIDTHS.flatMap((cols) => HEIGHTS.map((rows) => [cols, rows] as const)))(
		'says how many rows it left out at %i columns by %i rows',
		async (cols, rows) => {
			const screen = await open(cols, rows, zenOnly())
			expectWindowSaysWhatIsHidden(screen)
		},
	)

	it.each(WIDTHS.flatMap((cols) => HEIGHTS.map((rows) => [cols, rows] as const)))(
		'keeps the cursor row in view as it moves down, at %i columns by %i rows',
		async (cols, rows) => {
			const screen = await open(cols, rows, zenOnly())
			// The cursor starts on the provider the notice is about, the second row.
			for (let cursor = 3; cursor <= SEVEN_VENDORS; cursor++) {
				screen.press('\x1b[B')
				await vi.waitFor(async () => {
					await screen.waitForRender()
					expect(screen.viewport().join('\n')).toContain(`› ${cursor}.`)
				})
				expectWindowSaysWhatIsHidden(screen)
			}
		},
	)
})
