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
	it('reads like the reference: mode, pull request, shells, joined by dots', async () => {
		const text = await row({
			permissionMode: 'bypass',
			canCycleMode: true,
			pr: PR('approved'),
			shellCount: 1,
		})
		// A running background task takes the cycle key off the row, as in the reference.
		expect(text).toContain('⏵⏵ bypass permissions on · PR #592 · 1 shell')
		expect(text).not.toContain('/jobs')
		expect(text.trimEnd()).toMatch(/gpt-5\.6-terra$/)
		const noTask = await row({ permissionMode: 'bypass', canCycleMode: true, pr: PR('approved') })
		expect(noTask).toContain('⏵⏵ bypass permissions on (shift+tab to cycle) · PR #592')
	})

	// Reference (REA fn bGe, chunk-2rs9vjmc.js, with Fye in chunk-fdh2jsht.js): the
	// cycle key leaves the row only while a background task is counted, and the
	// count (`Bwt`) leaves agents and workflows out when the agents panel is on —
	// they are rows of their own. Shells are counted.
	it('counts monitors apart from shells in the same pill', async () => {
		expect(await row({ shellCount: 2, monitorCount: 1 })).toContain('2 shells · 1 monitor')
		expect(await row({ monitorCount: 3 })).toContain('3 monitors')
		expect(await row({ monitorCount: 3 })).not.toContain('shell')
	})

	it('keeps the cycle key beside running agents and drops it only for a running shell', async () => {
		const withAgents = await row(
			{ permissionMode: 'bypass', canCycleMode: true, agentCount: 2, canManage: true },
			140,
		)
		expect(withAgents).toContain(
			'⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents · ↓ to manage',
		)
		const withShell = await row(
			{ permissionMode: 'bypass', canCycleMode: true, agentCount: 2, shellCount: 1 },
			140,
		)
		expect(withShell).not.toContain('shift+tab to cycle')
		expect(withShell).toContain('1 shell')
	})

	it('puts esc to interrupt, the agents hint and the manage hint last, in the reference order', async () => {
		const text = await row(
			{
				permissionMode: 'bypass',
				canCycleMode: true,
				state: 'thinking',
				pr: PR('pending'),
				shellCount: 3,
				agentCount: 1,
				canManage: true,
			},
			140,
		)
		expect(text).toContain(
			'⏵⏵ bypass permissions on · PR #592 · 3 shells · esc to interrupt · ← 1 agent · ↓ to manage',
		)
		expect(text.trimEnd()).toMatch(/gpt-5\.6-terra$/)
	})

	it('names the agents hint with a plural and a cap, and only when there are agents', async () => {
		expect(await row({ agentCount: 1 })).toContain('← 1 agent')
		expect(await row({ agentCount: 2 })).toContain('← 2 agents')
		expect(await row({ agentCount: 120 })).toContain('← 99+ agents')
		expect(await row({ agentCount: 0 })).not.toContain('←')
		expect(await row({ workflowCount: 1 })).toContain('← 1 workflow')
		expect(await row({ workflowCount: 1 })).not.toContain('agent')
		expect(await row({ agentCount: 2, workflowCount: 1 })).toContain('← 2 agents · 1 workflow')
	})

	it('offers ↓ to manage only when told ↓ reaches something, and swaps it for enter while the pill is selected', async () => {
		expect(await row({ shellCount: 2 })).not.toContain('↓')
		expect(await row({ shellCount: 2, canManage: true })).toContain('2 shells · ↓ to manage')
		const selected = await row({ shellCount: 2, canManage: true, shellsSelected: true })
		expect(selected).toContain('2 shells · enter to view shells')
		expect(selected).not.toContain('↓ to manage')
	})

	it('shows no model name beside the hints when they leave no room', async () => {
		const props: Partial<StatusBarProps> = {
			permissionMode: 'bypass',
			canCycleMode: true,
			state: 'thinking',
			pr: PR('pending'),
			shellCount: 3,
			agentCount: 1,
			canManage: true,
		}
		const tight = await row(props, 96)
		expect(tight).toContain('↓ to manage')
		expect(tight).not.toContain('gpt-5.6-terra')
	})

	it.each([
		['bypass', '⏵⏵ bypass permissions on'],
		['classify', '⏵⏵ auto mode on'],
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
		expect(await row({ shellCount: 1 })).toContain('1 shell')
		expect(await row({ shellCount: 3 })).toContain('3 shells')
		expect(await row({ shellCount: 0 })).not.toContain('shell')
	})

	it('adds "esc to interrupt" after the mode while a turn runs', async () => {
		const text = await row({ permissionMode: 'bypass', canCycleMode: true, state: 'thinking' })
		expect(text).toContain('⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt')
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

	it('shortens the manage hint, drops the agents and interrupt hints, keeps the pointer, then the pill, and never wraps', async () => {
		const props: Partial<StatusBarProps> = {
			permissionMode: 'bypass',
			canCycleMode: true,
			state: 'thinking',
			shellCount: 2,
			pr: PR('approved'),
			agentCount: 1,
			canManage: true,
		}
		for (const cols of [140, 100, 80, 64, 50, 40, 30]) {
			const text = await row(props, cols)
			expect(text.length).toBeLessThanOrEqual(cols)
		}
		const wide = await row(props, 110)
		expect(wide).toContain('↓ to manage')
		const shortManage = await row(props, 79)
		expect(shortManage).toContain('esc to interrupt')
		expect(shortManage).toContain('↓ agents')
		expect(shortManage).not.toContain('↓ to manage')
		expect(shortManage).not.toContain('← 1 agent')
		const noInterrupt = await row(props, 69)
		expect(noInterrupt).toContain('2 shells')
		expect(noInterrupt).toContain('↓ agents')
		expect(noInterrupt).not.toContain('esc to interrupt')
		const pointerGone = await row(props, 55)
		expect(pointerGone).toContain('2 shells')
		expect(pointerGone).not.toContain('↓ agents')
		const narrow = await row(props, 45)
		expect(narrow).toContain('⏵⏵ bypass permissions on')
		expect(narrow).toContain('PR #592')
		expect(narrow).not.toContain('shift+tab')
	})
})
