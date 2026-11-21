import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { QuestionDialog } from '../QuestionDialog.js'
import type { UserQuestion } from '../agent.js'

/** A focused option's description of about 190 characters is shown whole on a narrow screen. */

const LONG =
	'Use the same currency and formatting as the report lines, which read TALLY_CURRENCY and fall back to the locale of the machine when it is not set, then round to two decimals'

const question: UserQuestion = {
	questionId: 'q1',
	question: 'Which currency format?',
	options: [
		{ id: 'a', label: 'Config currency', description: LONG },
		{ id: 'b', label: 'Plain amount', description: 'Only the amount' },
	],
	multiSelect: false,
	allowFreeText: true,
}

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
})

it.each([40, 56, 70])('shows the whole focused description at %i columns', async (columns) => {
	const harness = render(
		<QuestionDialog question={question} columns={columns} onAnswer={() => {}} />,
	)
	mounted.push(harness)
	await vi.waitFor(() => expect(harness.lastFrame()).toContain('Which currency format?'))
	const text = (harness.lastFrame() ?? '').replace(/\s+/g, ' ')
	expect(text).toContain('round to two decimals')
	expect(text).not.toContain('decimals …')
})
