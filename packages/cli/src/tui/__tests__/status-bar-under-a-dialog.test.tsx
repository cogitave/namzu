/**
 * One footer rule for every screen that owns the keyboard: the mode stays, and
 * no key is named that the screen does not answer to. Under a permission
 * dialog Esc declines, so the footer must not offer it as "interrupt".
 */

import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { StatusBar } from '../StatusBar.js'

function frame(props: { dialogOpen?: boolean; hint?: string; hintDim?: boolean }): string {
	const view = render(
		<StatusBar
			provider="p"
			model="gpt-test"
			state="awaiting-permission"
			permissionMode="bypass"
			canCycleMode
			composerMounted
			{...props}
		/>,
	)
	const out = view.lastFrame() ?? ''
	view.unmount()
	return out
}

describe('the footer under a dialog', () => {
	it('shows esc to interrupt and the cycle key while the composer owns the keys', () => {
		const out = frame({})
		expect(out).toContain('bypass permissions on (shift+tab to cycle)')
		expect(out).toContain('esc to interrupt')
	})

	it('keeps the mode but drops both keys while a dialog owns them', () => {
		const out = frame({ dialogOpen: true })
		expect(out).toContain('bypass permissions on')
		expect(out).not.toContain('shift+tab')
		expect(out).not.toContain('esc to interrupt')
	})

	it('shows the exit reminder in the hint slot', () => {
		const out = frame({ hint: 'Press Ctrl-C again to exit', hintDim: true })
		expect(out).toContain('Press Ctrl-C again to exit')
		expect(out).not.toContain('esc to interrupt')
	})
})
