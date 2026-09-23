/**
 * A browser call's result that opens with a note longer than the summary row
 * used to be printed twice: cut off at 120 characters on the `⎿` row, and in
 * full again as the first line of the body. A person saw "A navigation to
 * https://iana.org was blocked…" twice in a row. A first line up to
 * {@link RESULT_SUMMARY_WHOLE_MAX} characters is now the whole summary row and
 * leaves the body; a longer one is still kept in the body, where expanding
 * shows it whole.
 */

import { expect, it } from 'vitest'

import { type SessionEvent, ToolRegistry, type TurnId, createToolPresenter } from '@namzu/sdk'

import { RESULT_SUMMARY_WHOLE_MAX, toAgentEvent } from '../agent.js'

const presenter = createToolPresenter(new ToolRegistry())
const turnId = '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as TurnId

function completed(result: string) {
	const event = toAgentEvent(
		{
			type: 'tool_completed',
			turnId,
			toolUseId: 'call',
			toolName: 'browser_act',
			isError: false,
			result,
		} as unknown as SessionEvent,
		presenter,
	)
	if (event?.kind !== 'tool-end') throw new Error('missing completion')
	return event
}

const NOTE =
	'A navigation to https://iana.org was blocked before it was sent: https://iana.org was not asked for and the site rules need approval to open it. To go there, open it with navigate.'

it('shows a note of a few rows once, whole, on the summary row', () => {
	expect(NOTE.length).toBeGreaterThan(120)
	const event = completed(`${NOTE}\nPage: https://example.com — "Example Domain" (tab t1)\n- link`)
	expect(event.summary).toBe(NOTE)
	expect(event.detail?.[0]).toBe('Page: https://example.com — "Example Domain" (tab t1)')
	expect(event.detail?.join('\n')).not.toContain('was blocked')
})

it('does not repeat a single line of a few rows under itself', () => {
	const event = completed(NOTE)
	expect(event.summary).toBe(NOTE)
	expect(event.detail).toBeUndefined()
})

it('keeps a first line longer than the row can show whole in the body', () => {
	const long = `${'y'.repeat(RESULT_SUMMARY_WHOLE_MAX)}END`
	const event = completed(`${long}\nsecond`)
	expect(event.summary.length).toBeLessThanOrEqual(120)
	expect(event.detail?.[0]).toBe(long)
})
