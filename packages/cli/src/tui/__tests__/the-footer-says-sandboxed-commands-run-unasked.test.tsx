/**
 * In `prompt` mode with a confining sandbox the footer's resting hint says
 * that commands in the sandbox run without asking; anywhere else it is the
 * usual cycle reminder.
 */

import { describe, expect, it } from 'vitest'

import { StatusBar, type StatusBarProps } from '../StatusBar.js'
import { renderToScreen } from './support/screen.js'

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

describe('the resting footer', () => {
	it('says sandbox commands run unasked in prompt mode', async () => {
		const text = await row({ permissionMode: 'prompt', sandboxShell: true })
		expect(text).toContain('sandbox commands run unasked · shift+tab to cycle')
	})

	it('keeps the usual reminder without a confining sandbox', async () => {
		const text = await row({ permissionMode: 'prompt' })
		expect(text).toContain('shift+tab to cycle')
		expect(text).not.toContain('sandbox')
	})

	it('drops the longer sentence whole on a narrow row, never half of it', async () => {
		const text = await row({ permissionMode: 'prompt', sandboxShell: true }, 48)
		expect(text).not.toContain('sandbox commands')
		expect(text).not.toContain('shift+tab')
	})

	it('leaves a non-default mode to its own badge', async () => {
		const text = await row({ permissionMode: 'plan', canCycleMode: true, sandboxShell: true })
		expect(text).toContain('plan mode on')
		expect(text).not.toContain('sandbox')
	})
})
