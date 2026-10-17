import stringWidth from 'string-width'
import { afterEach, describe, expect, it } from 'vitest'

import { PendingInputPanel, pendingInputPanelRows } from '../PendingInputPanel.js'
import { type Screen, renderToScreen } from './support/screen.js'

let screen: Screen | null = null
afterEach(async () => {
	await screen?.unmount()
	screen = null
})

const lines = (s: Screen) => s.viewport().filter((row) => row.length > 0)

describe('pending input on the terminal screen', () => {
	it('lists each message as a grey pointer row, with the queued one saying when it runs', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: 'check server log', attachmentCount: 1, attachmentLabel: 'image' }]}
				queued={[{ text: 'then write the summary' }]}
				columns={80}
				rows={24}
				working
			/>,
			{ cols: 80, rows: 24 },
		)
		expect(lines(screen)).toEqual([
			' ❯ check server log [1 image]',
			' ❯ then write the summary · after this reply',
			'   ctrl+x ctrl+s to send now',
		])
		expect(
			pendingInputPanelRows({
				pendingSteers: [{ text: 'steer' }],
				queued: [{ text: 'next' }],
				rows: 24,
				working: true,
			}),
		).toBe(3)
		expect(screen.bufferType()).toBe('normal')
	})

	it('keeps the send-now hint only while a reply runs', async () => {
		screen = await renderToScreen(
			<PendingInputPanel pendingSteers={[]} queued={[{ text: 'later' }]} columns={80} rows={24} />,
			{ cols: 80, rows: 24 },
		)
		expect(screen.viewport().join('\n')).not.toContain('send now')
		expect(lines(screen)).toHaveLength(1)
	})

	it('shows the newest rows, folds the older ones, and never overruns its reserved height', async () => {
		const queued = ['one', 'two', 'three', 'four', 'five'].map((text) => ({ text }))
		screen = await renderToScreen(
			<PendingInputPanel pendingSteers={[]} queued={queued} columns={60} rows={24} working />,
			{ cols: 60, rows: 24 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('five')
		expect(visible).toContain('three')
		expect(visible).not.toContain('two')
		expect(visible).toContain('+2 more messages')
		expect(lines(screen)).toHaveLength(
			pendingInputPanelRows({ pendingSteers: [], queued, rows: 24, working: true }),
		)
	})

	it('marks the chosen queued message and dims the pointer on the others', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[]}
				queued={[{ text: 'first' }, { text: 'second' }]}
				columns={60}
				rows={24}
				selectedQueued={0}
				working
			/>,
			{ cols: 60, rows: 24 },
		)
		expect(lines(screen).slice(0, 2)).toEqual([
			' ❯ first · after this reply',
			'   second · after this reply',
		])
	})

	it('keeps the chosen message in view when it is older than the rows shown', async () => {
		const queued = ['a', 'b', 'c', 'd', 'e'].map((text) => ({ text }))
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[]}
				queued={queued}
				columns={60}
				rows={24}
				selectedQueued={0}
			/>,
			{ cols: 60, rows: 24 },
		)
		expect(screen.viewport().join('\n')).toContain('❯ a')
	})

	it('keeps control characters and invisible direction changes out of terminal commands', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: 'look\x1b[2J now\r‮' }]}
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
		expect(visible).not.toContain('‮')
		expect(screen.bufferType()).toBe('normal')
	})

	it('bounds long pasted text and fits a narrow screen', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: `first ${'long '.repeat(10_000)}LAST` }]}
				queued={[{ text: 'second queued', attachmentCount: 2 }]}
				columns={32}
				rows={24}
				working
			/>,
			{ cols: 32, rows: 24 },
		)
		const visible = screen.viewport().join('\n')
		expect(visible).toContain('[2 attachments]')
		expect(visible).not.toContain('LAST')
		for (const row of screen.viewport()) expect(stringWidth(row)).toBeLessThanOrEqual(32)
	})

	it('says how a held queue continues, in the words of the keys that exist', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[]}
				queued={[{ text: 'operator correction' }]}
				columns={110}
				rows={24}
				held={{ outcome: 'failed' }}
			/>,
			{ cols: 110, rows: 24 },
		)
		expect(lines(screen)).toEqual([
			' ❯ operator correction · after this reply',
			'   Paused after the failed reply · send a message to run them',
		])
		expect(
			pendingInputPanelRows({
				pendingSteers: [],
				queued: [{ text: 'x' }],
				rows: 24,
				held: { outcome: 'failed' },
			}),
		).toBe(2)
	})

	it('collapses to one message row on a short screen', async () => {
		screen = await renderToScreen(
			<PendingInputPanel
				pendingSteers={[{ text: 'steer' }]}
				queued={[{ text: 'queued' }]}
				columns={40}
				rows={14}
				working
			/>,
			{ cols: 40, rows: 14 },
		)
		expect(lines(screen)).toEqual([' ❯ queued · after this reply', '   +1 more message'])
	})
})
