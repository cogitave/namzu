/**
 * The hint survives a realistic working directory.
 *
 * The status bar is one line that truncates, and the hint is the only place any
 * key is advertised. Three separate fixes landed recently on the strength of
 * that advertisement — the trust gate naming `Esc`, the permission prompt
 * naming every key that decides it, the picker naming its exits — and every one
 * of them is sound about the wrong thing if the line the operator actually sees
 * ends before the hint begins.
 *
 * So these render at the harness's 100 columns, which is an ordinary terminal
 * width, with paths of the kind people really work in. A test that used a short
 * cwd would prove the hint is BUILT, which was never in doubt.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'
import type { PrFooterState } from '../pr-status.js'

/** The picker's first-run hint: the only place its exits are named. */
const HINT = '↑↓ select · enter accept · esc or Ctrl+C exit'

function frameFor(options: {
	readonly hint?: string
	readonly model?: string
	readonly shellCount?: number
	readonly effort?: string
	readonly pr?: PrFooterState
}): string {
	const { lastFrame, unmount } = render(
		<StatusBar
			provider="anthropic-personal (anthropic)"
			model={options.model ?? 'claude-opus-4-7'}
			state="idle"
			hint={options.hint ?? HINT}
			permissionMode="auto"
			canCycleMode
			shellCount={options.shellCount}
			effort={options.effort}
			pr={options.pr}
		/>,
	)
	const frame = lastFrame() ?? ''
	unmount()
	return frame
}

describe('the hint at a realistic width', () => {
	it('survives the mode, a shell pill and a pull request on the same row', () => {
		const frame = frameFor({
			shellCount: 2,
			effort: 'xhigh',
			pr: { kind: 'pr', number: 592, url: 'https://example.test/pull/592', review: 'pending' },
		})
		expect(frame, 'the exit keys were truncated away').toContain('Ctrl+C')
		expect(frame).toContain('esc')
	})

	it('survives a model name long enough to fill the line on its own', () => {
		// If the width cannot hold both, the left items go and the keys stay: the
		// key advertisement exists in exactly one place on the screen.
		const frame = frameFor({ model: `${'very-long-model-name-'.repeat(8)}leaf` })
		expect(frame, 'the exit keys lost to the model').toContain('Ctrl+C')
	})
})
