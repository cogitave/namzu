/**
 * The bar must not show a run nobody could price as a run that cost nothing.
 *
 * `/cost` is asked; the status bar is merely seen, which makes it the surface
 * more likely to be believed without thinking. It printed the token count alone
 * whenever the total was not above zero — and since nothing fed the kernel's
 * cost calculation, that was every run. An operator reads a missing cost as no
 * cost.
 *
 * Rendered rather than unit-tested against `formatUsage`, which is not
 * exported: the question here is what reaches the screen, and a helper test
 * would prove the string is BUILT, which was never the part in doubt.
 */

import type { CostInfo } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'

const cost = (totalCost: number, over: Partial<CostInfo> = {}): CostInfo => ({
	totalCost,
	cacheDiscount: 0,
	unpricedTokens: 0,
	...over,
})

function frameFor(usage: { totalTokens: number; cost: CostInfo }): string {
	const { lastFrame, unmount } = render(
		<StatusBar cwd="/w" provider="p" model="m" state="idle" usage={usage} />,
	)
	const frame = lastFrame() ?? ''
	unmount()
	return frame
}

describe('the status bar and an unpriced run', () => {
	it('marks the cost as unknown rather than omitting it', () => {
		const frame = frameFor({ totalTokens: 2_000, cost: cost(0, { unpricedTokens: 2_000 }) })

		expect(frame).toContain('$?')
		// The one thing that must not happen: a figure standing in for a figure
		// nobody has.
		expect(frame).not.toContain('$0.00')
	})

	it('shows a genuinely free run differently from an unpriced one', () => {
		// Both totals are zero. A test looking at either alone would pass
		// against the behaviour being replaced, which gave them one rendering.
		const free = frameFor({ totalTokens: 2_000, cost: cost(0) })
		const unknown = frameFor({ totalTokens: 2_000, cost: cost(0, { unpricedTokens: 2_000 }) })

		expect(free).not.toBe(unknown)
		expect(free).not.toContain('$?')
	})

	it('still prints a real total when the run was fully priced', () => {
		// Guards the change from being "always show $?": the ordinary case has
		// to keep working, and a mutation that returned the marker
		// unconditionally would otherwise pass the two cases above.
		expect(frameFor({ totalTokens: 2_000, cost: cost(1.234) })).toContain('$1.23')
	})

	it('marks a partly-priced run as unknown rather than quoting the floor alone', () => {
		// A total above zero AND unpriced tokens. Quoting `$0.50` here reads as
		// the answer when it is only a floor, so the bar defers to `/cost`.
		const frame = frameFor({ totalTokens: 2_000, cost: cost(0.5, { unpricedTokens: 400 }) })

		expect(frame).toContain('$?')
		expect(frame).not.toContain('$0.50')
	})
})
