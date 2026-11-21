import { afterEach, expect, it } from 'vitest'

import { ChoicePicker } from '../ChoicePicker.js'
import { type Screen, renderToScreen } from './support/screen.js'

/**
 * A question's options: the cursor's option shows its whole description, and
 * the corner carries no `1/4` that would read as "question 1 of 4".
 */

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
})

const LONG =
	'Use the same currency and formatting as the report lines, which read TALLY_CURRENCY and fall back to the locale of the machine'
const options = [
	{ label: 'Config currency, as reports do', description: LONG, recommended: true },
	{ label: 'Plain amount, no symbol', description: 'Show only the two-decimal amount' },
	{ label: 'Something else…', description: 'Answer in your own words' },
]

for (const cols of [100, 50]) {
	it(`shows the whole description of the focused option at ${cols} columns, with no count`, async () => {
		mounted = await renderToScreen(
			<ChoicePicker
				title="Which currency format?"
				options={options}
				selected={0}
				describeSelected
			/>,
			{ cols, rows: 24 },
		)
		const text = mounted
			.viewport()
			.join(' ')
			.replace(/[│╭╮╰╯─]/g, ' ')
			.replace(/\s+/g, ' ')
		expect(text).toContain(LONG)
		expect(text).not.toContain('formatting as the re…')
		expect(text).not.toMatch(/\b1\/3\b/)
	})
}

it('keeps the count for a list that is not a question', async () => {
	mounted = await renderToScreen(<ChoicePicker title="Pick one" options={options} selected={0} />, {
		cols: 100,
		rows: 24,
	})
	expect(mounted.viewport().join('\n')).toMatch(/1\/3/)
})
