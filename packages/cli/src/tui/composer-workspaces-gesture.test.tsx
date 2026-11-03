/**
 * `←` on an empty composer: opens the workspaces screen where there is one, only
 * arms right after the draft was emptied by editing, and keeps the agents
 * cockpit where there is no workspaces screen. The clock is the test's own.
 */

import { render } from 'ink-testing-library'
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer, type ComposerProps } from './Composer.js'
import type { Notice } from './notifications.js'
import { COOLDOWN_MS, EDITED_MS, REPEAT_MS } from './zoom/gesture.js'

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

	it('opens the agents cockpit where there is no workspaces screen', async () => {
		const { app, calls } = mount({ onOpenWorkspaces: undefined })
		await tick()
		await press(app, LEFT)
		expect(calls.agents).toBe(1)
		app.unmount()
	})
})
