/**
 * The footer's shells pill, pull request item and interrupt hint, rendered
 * into an emulated terminal: one row, items joined by a dim ` · `, nothing
 * wrapping. Colors are read from the cell attributes, not guessed from text.
 */

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar, type StatusBarProps } from '../StatusBar.js'
import type { PrFooterState } from '../pr-status.js'
import { renderToScreen } from './support/screen.js'

const PR = (review: 'approved' | 'changes' | 'pending' | 'merged' | 'draft'): PrFooterState => ({
	kind: 'pr',
	number: 592,
	url: 'https://example.test/o/r/pull/592',
	review,
})

async function row(props: Partial<StatusBarProps>, cols = 100): Promise<string> {
	const screen = await renderToScreen(
		<StatusBar provider="p" model="gpt-5.6-terra" state="idle" {...props} />,
		{ cols, rows: 4 },
	)
	try {
		return screen.viewport()[0] ?? ''
	} finally {
		await screen.unmount()
	}
}

describe('the footer row', () => {
	it('reads like the reference: mode, shells, pull request, joined by dots', async () => {
		const text = await row({
			permissionMode: 'auto',
			canCycleMode: true,
			shellCount: 1,
			pr: PR('approved'),
		})
		expect(text).toContain(
			'⏵⏵ bypass permissions on (shift+tab to cycle) · 1 shell /jobs to manage · PR #592',
		)
		expect(text.trimEnd()).toMatch(/gpt-5\.6-terra$/)
	})

	it.each([
		['auto', '⏵⏵ bypass permissions on'],
		['accept-edits', '⏵⏵ accept edits on'],
		['plan', '‖ plan mode on'],
		['strict', '‖ preapproved only on'],
	] as const)('words the %s mode', async (permissionMode, words) => {
		expect(await row({ permissionMode, canCycleMode: true })).toContain(words)
	})

	it('shows no mode item for the default mode, only the quiet reminder when the row is otherwise empty', async () => {
		const quiet = await row({ permissionMode: 'prompt', canCycleMode: true })
		expect(quiet).toContain('shift+tab to cycle')
		expect(quiet).not.toContain('⏵⏵')
		const busy = await row({ permissionMode: 'prompt', canCycleMode: true, shellCount: 2 })
		expect(busy).not.toContain('shift+tab')
		expect(busy).toContain('2 shells')
	})

	it('pluralises the shell pill and leaves it out at zero', async () => {
		expect(await row({ shellCount: 1 })).toContain('1 shell /jobs')
		expect(await row({ shellCount: 3 })).toContain('3 shells /jobs')
		expect(await row({ shellCount: 0 })).not.toContain('shell')
	})

	it('swaps the cycle key for "esc to interrupt" while a turn runs', async () => {
		const text = await row({ permissionMode: 'auto', canCycleMode: true, state: 'thinking' })
		expect(text).toContain('⏵⏵ bypass permissions on · esc to interrupt')
		expect(text).not.toContain('shift+tab')
		const quiet = await row({ state: 'tool' })
		expect(quiet).toContain('esc to interrupt')
	})

	it('does not say "esc to interrupt" twice when the right side already carries a hint', async () => {
		const text = await row({ state: 'thinking', hint: 'enter steer · tab queue · esc interrupt' })
		expect(text).not.toContain('esc to interrupt')
		expect(text).toContain('enter steer')
	})

	it('draws the PR link as plain text without hyperlink support', async () => {
		const plain = await row({ pr: PR('pending'), hyperlinks: false })
		expect(plain).toContain('PR #592')
	})

	it('wraps the number in an OSC 8 link only when the terminal supports it', () => {
		const raw = (hyperlinks: boolean): string => {
			const h = render(
				<StatusBar
					provider="p"
					model="m"
					state="idle"
					pr={PR('pending')}
					hyperlinks={hyperlinks}
				/>,
			)
			const frame = h.lastFrame() ?? ''
			h.unmount()
			return frame
		}
		expect(raw(true)).toContain('\u001b]8;;https://example.test/o/r/pull/592\u001b\\#592')
		expect(raw(false)).not.toContain('\u001b]8;')
	})

	it('names a missing or signed-out gh, dim, and nothing else', async () => {
		expect(await row({ pr: { kind: 'notice', text: 'install gh for PR status' } })).toContain(
			'install gh for PR status',
		)
		expect(await row({ pr: { kind: 'none' } })).not.toContain('PR')
	})

	it('drops the shells hint, then the cycle key, then the PR item, and never wraps', async () => {
		const props: Partial<StatusBarProps> = {
			permissionMode: 'auto',
			canCycleMode: true,
			shellCount: 2,
			pr: PR('approved'),
		}
		for (const cols of [140, 100, 80, 64, 50, 40, 30]) {
			const text = await row(props, cols)
			expect(text.length).toBeLessThanOrEqual(cols)
		}
		const mid = await row(props, 62)
		expect(mid).toContain('2 shells')
		expect(mid).not.toContain('/jobs to manage')
		const narrow = await row(props, 44)
		expect(narrow).toContain('⏵⏵ bypass permissions on')
		expect(narrow).toContain('2 shells')
		expect(narrow).not.toContain('shift+tab')
	})
})
