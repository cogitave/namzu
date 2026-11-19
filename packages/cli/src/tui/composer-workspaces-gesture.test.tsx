/**
 * `←` on an empty composer: opens the workspaces screen where there is one and only arms right
 * after the draft was emptied by editing. Where there is none, it does nothing while the
 * session is idle, and while a reply runs the first press says "Press ← again to open agents"
 * and the second opens the agents (never the workflow view); `tui.leftArrowOpensAgents: false`
 * turns that off. The clock is the test's own.
 */

import { render } from 'ink-testing-library'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer, type ComposerProps } from './Composer.js'
import type { Notice } from './notifications.js'
import { ARM_MS, COOLDOWN_MS, EDITED_MS, REPEAT_MS } from './zoom/gesture.js'

const LEFT = '\u001b[D'
const SHIFT_LEFT = '\u001b[1;2D'
const BACKSPACE = '\u007f'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function mount(extra: Partial<ComposerProps> = {}) {
	const calls = { workspaces: 0, agents: 0, notices: [] as Notice[] }
	const props: ComposerProps = {
		onSubmit: () => undefined,
		history: [],
		onOpenWorkspaces: () => {
			calls.workspaces += 1
		},
		onOpenAgents: () => {
			calls.agents += 1
		},
		onFooterNotice: (notice) => {
			calls.notices.push(notice)
		},
		...extra,
	}
	const app = render(React.createElement(Composer, props))
	return { app, calls }
}

const press = async (app: ReturnType<typeof render>, input: string) => {
	app.stdin.write(input)
	await tick()
}

describe('← on the composer', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date(1_000_000))
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it('opens the workspaces screen on a single press when nothing was typed', async () => {
		const { app, calls } = mount()
		await tick()
		await press(app, LEFT)
		expect(calls.workspaces).toBe(1)
		expect(calls.agents).toBe(0)
		app.unmount()
	})

	it('keeps the key for the cursor once there is text, or a modifier', async () => {
		const { app, calls } = mount()
		await tick()
		await press(app, 'ab')
		await press(app, LEFT)
		expect(calls.workspaces).toBe(0)
		await press(app, BACKSPACE)
		await press(app, BACKSPACE)
		vi.setSystemTime(Date.now() + EDITED_MS + 1)
		await press(app, SHIFT_LEFT)
		expect(calls.workspaces).toBe(0)
		app.unmount()
	})

	it('only arms right after the draft was emptied by editing, and a second press opens', async () => {
		const { app, calls } = mount()
		await tick()
		await press(app, 'ab')
		await press(app, BACKSPACE)
		await press(app, BACKSPACE)
		vi.setSystemTime(Date.now() + REPEAT_MS + 1)
		await press(app, LEFT)
		expect(calls.workspaces).toBe(0)
		expect(calls.notices.at(-1)?.text).toBe('Press ← again to open workspaces')
		vi.setSystemTime(Date.now() + COOLDOWN_MS + 1)
		await press(app, LEFT)
		expect(calls.workspaces).toBe(1)
		app.unmount()
	})

	it('swallows a held key', async () => {
		const { app, calls } = mount()
		await tick()
		await press(app, LEFT)
		vi.setSystemTime(Date.now() + 10)
		await press(app, LEFT)
		vi.setSystemTime(Date.now() + 10)
		await press(app, LEFT)
		expect(calls.workspaces).toBe(1)
		app.unmount()
	})

	it('does nothing where there is no workspaces screen and no reply is running', async () => {
		const { app, calls } = mount({ onOpenWorkspaces: undefined })
		await tick()
		await press(app, LEFT)
		expect(calls.agents).toBe(0)
		expect(calls.notices).toEqual([])
		app.unmount()
	})

	it('says "Press ← again to open agents" first while a reply runs, and the second press opens them', async () => {
		const { app, calls } = mount({ onOpenWorkspaces: undefined, replyRunning: true })
		await tick()
		await press(app, LEFT)
		expect(calls.agents).toBe(0)
		expect(calls.notices.at(-1)?.text).toBe('Press ← again to open agents')
		vi.setSystemTime(Date.now() + REPEAT_MS + 1)
		await press(app, LEFT)
		expect(calls.agents).toBe(1)
		expect(calls.workspaces).toBe(0)
		app.unmount()
	})

	it('lets the hint lapse: a press after the window arms again instead of opening', async () => {
		const { app, calls } = mount({ onOpenWorkspaces: undefined, replyRunning: true })
		await tick()
		await press(app, LEFT)
		vi.setSystemTime(Date.now() + ARM_MS + 1)
		await press(app, LEFT)
		expect(calls.agents).toBe(0)
		expect(calls.notices.filter((n) => n.text === 'Press ← again to open agents')).toHaveLength(2)
		app.unmount()
	})

	it('does not read a held key as the second press', async () => {
		const { app, calls } = mount({ onOpenWorkspaces: undefined, replyRunning: true })
		await tick()
		await press(app, LEFT)
		vi.setSystemTime(Date.now() + 10)
		await press(app, LEFT)
		expect(calls.agents).toBe(0)
		app.unmount()
	})

	it('leaves the key alone when the setting is off, and when text was typed', async () => {
		const off = mount({
			onOpenWorkspaces: undefined,
			replyRunning: true,
			leftArrowOpensAgents: false,
		})
		await tick()
		await press(off.app, LEFT)
		vi.setSystemTime(Date.now() + REPEAT_MS + 1)
		await press(off.app, LEFT)
		expect(off.calls.agents).toBe(0)
		expect(off.calls.notices).toEqual([])
		off.app.unmount()
		const typed = mount({ onOpenWorkspaces: undefined, replyRunning: true })
		await tick()
		await press(typed.app, 'ab')
		await press(typed.app, LEFT)
		await press(typed.app, LEFT)
		expect(typed.calls.agents).toBe(0)
		typed.app.unmount()
	})
})
