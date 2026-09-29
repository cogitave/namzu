import stringWidth from 'string-width'
import { afterEach, describe, expect, it } from 'vitest'

import { PendingInputPanel, pendingInputPanelRows } from '../PendingInputPanel.js'
import { type Screen, renderToScreen } from './support/screen.js'

let screen: Screen | null = null
afterEach(async () => {
	await screen?.unmount()
	screen = null
})

describe('pending input on the terminal screen', () => {
	it('shows the authored messages and their different delivery boundaries at 40 by 14', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: 'check server log', attachmentCount: 1, attachmentLabel: 'image' }]}
				queued={[{ text: 'then write the summary' }]}
				columns={40}
				rows={14}
				canRecall
			/>,
			{ cols: 40, rows: 14 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Steer→turn')
		expect(visible).toContain('check server log [1 image]')
		expect(visible).toContain('Queue→next')
		expect(visible).toContain('then write the summary')
		expect(visible).toContain('Alt+Up edit last message')
		expect(screen.viewport().filter((row) => row.length > 0)).toHaveLength(3)
		expect(pendingInputPanelRows({ pendingSteers: [{ text: 'steer' }], queued: [{ text: 'next' }], rows: 14, canRecall: true })).toBe(3)
		expect(screen.bufferType()).toBe('normal')
		for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(40)
	})

	it('keeps control characters and invisible direction changes out of terminal commands', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: 'look\x1b[2J now\r\u202e' }]}
				queued={[{ text: 'first\nsecond\tpart' }]}
				columns={80}
				rows={20}
			/>,
			{ cols: 80, rows: 20 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('look\\u{001b}[2J now\\u{000d}\\u{202e}')
		expect(visible).toContain('first second part')
		expect(visible).not.toContain('\x1b[2J')
		expect(visible).not.toContain('\u202e')
		expect(screen.bufferType()).toBe('normal')
	})

	it('limits both groups and exposes overflow without hiding the next message', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: 'steer first' }, { text: 'steer second' }, { text: 'steer third' }]}
				queued={[{ text: 'queued first' }, { text: 'queued second' }, { text: 'queued third' }]}
				columns={40}
				rows={14}
				canRecall={false}
			/>,
			{ cols: 40, rows: 14 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('steer first')
		expect(visible).toContain('Steer→turn 3 steer first (+2)')
		expect(visible).toContain('queued first')
		expect(visible).toContain('Queue→next 3 queued first (+2)')
		expect(visible).not.toContain('steer second')
		expect(visible).not.toContain('queued second')
		expect(visible).not.toContain('Alt+Up')
		expect(screen.viewport().filter((row) => row.length > 0)).toHaveLength(2)
	})

	it('shows the latest queued text to be recalled even when the short view hides middle items', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: 'urgent steer' }, { text: 'another steer' }]}
				queued={[{ text: 'queued first' }, { text: 'queued middle' }, { text: 'queued third' }]}
				columns={40}
				rows={14}
				canRecall
			/>,
			{ cols: 40, rows: 14 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('urgent steer')
		expect(visible).toContain('queued first')
		expect(visible).toContain('Queue→next 3 queued first (+2)')
		expect(visible).toContain('Alt+Up edit last message: queued third')
		expect(visible).not.toContain('queued middle')
		expect(screen.viewport().filter((row) => row.length > 0)).toHaveLength(3)
	})

	it('shows two from each group on a taller screen and bounds long pasted text', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: `first ${'long '.repeat(10_000)}LAST` }, { text: 'second steer' }]}
				queued={[{ text: 'first queued' }, { text: 'second queued', attachmentCount: 2 }]}
				columns={32}
				rows={24}
				canRecall
			/>,
			{ cols: 32, rows: 24 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('second steer')
		expect(visible).toContain('first queued')
		expect(visible).toContain('second q')
		expect(visible).toContain('[2 attachments]')
		expect(visible).not.toContain('LAST')
		for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(32)
	})

	it('describes a held queue and previews the operator message recalled before an automatic item', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[]}
				queued={[{ text: 'operator correction' }, { text: 'Automatic goal continuation' }]}
				columns={50}
				rows={14}
				canRecall
				recallItem={{ text: 'operator correction' }}
				held={{ outcome: 'stopped', source: 'operator-interrupt' }}
			/>,
			{ cols: 50, rows: 14 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('Queue held 2 operator correction (+1)')
		expect(visible).toContain('Alt+Up edit last message: operator correction')
		expect(visible).not.toContain('edit last message: Automatic goal')
		expect(screen.viewport().filter((row) => row.length > 0)).toHaveLength(2)
	})
})
