import { describe, expect, it } from 'vitest'
import type { FakePty } from '../../terminal/__tests__/support/fake-pty.js'
import { ATTR_INVERSE } from '../../terminal/host/cell.js'
import { setup } from './support/harness.js'

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const press = (x: number, y: number) => `${ESC}[<0;${x + 1};${y + 1}M`
const drag = (x: number, y: number) => `${ESC}[<32;${x + 1};${y + 1}M`
const release = (x: number, y: number) => `${ESC}[<0;${x + 1};${y + 1}m`
const wheelUp = (x: number, y: number) => `${ESC}[<64;${x + 1};${y + 1}M`
const wheelDown = (x: number, y: number) => `${ESC}[<65;${x + 1};${y + 1}M`
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')
const osc = (text: string) => `${ESC}]52;c;${b64(text)}${BEL}`

/** A hundred columns: the pane's inside starts at column 26 and row 1, 74 wide and 29 tall. */
const X = 26
const Y = 1

function rig(extra: Parameters<typeof setup>[1] = {}, columns = 100) {
	const clock = { now: 0 }
	const t = setup({ columns, rows: 30 }, { now: () => clock.now, env: {}, ...extra })
	t.host.start()
	const pty = t.spawned[0] as FakePty
	const screen = () =>
		(t.host.roster.selected?.child as { screen: { settled(): Promise<void> } }).screen
	const print = async (text: string) => {
		pty.print(text)
		await screen().settled()
		await t.frame()
	}
	const since = (mark: number) => t.written.slice(mark).join('')
	const drive = async (...events: string[]) => {
		for (const event of events) t.type(event)
		await t.frame()
	}
	return { t, pty, print, since, drive, clock }
}

const CONTENT = 'hello world\r\nsecond line   \r\nthird'

describe('selecting text in a pane', () => {
	it('copies the dragged cells as one clipboard request and highlights them until the note fades', async () => {
		const { t, print, since, drive } = rig()
		await print(CONTENT)
		const mark = t.written.length
		await drive(press(X, Y), drag(X + 2, Y), drag(X + 4, Y))
		// Highlighted while the button is down.
		expect((await t.cellAt(X + 1, Y))?.attrs ?? 0).toSatisfy(
			(a: number) => (a & ATTR_INVERSE) !== 0,
		)
		expect(since(mark)).not.toContain(`${ESC}]52`)
		await drive(release(X + 4, Y))
		expect(since(mark)).toContain(osc('hello'))
		expect((await t.cellAt(X, Y))?.attrs ?? 0).toSatisfy((a: number) => (a & ATTR_INVERSE) !== 0)
		const shown = (await t.screen()).join('\n')
		expect(shown).toContain('Sent 5 characters to your clipboard')
		expect(shown).toContain('Hold Shift')
		// The note and the highlight go when its time is up.
		t.tick(2000)
		await t.frame()
		expect((await t.cellAt(X, Y))?.attrs ?? 0).toSatisfy((a: number) => (a & ATTR_INVERSE) === 0)
		expect((await t.screen()).join('\n')).not.toContain('Sent 5 characters')
	})

	it('joins rows with line breaks and trims trailing blanks', async () => {
		const { t, print, since, drive } = rig()
		await print(CONTENT)
		const mark = t.written.length
		await drive(press(X + 3, Y), drag(X + 4, Y + 2), release(X + 4, Y + 2))
		expect(since(mark)).toContain(osc('lo world\nsecond line\nthird'))
	})

	it('selects the same text dragging backwards', async () => {
		const { t, print, since, drive } = rig()
		await print(CONTENT)
		const mark = t.written.length
		await drive(press(X + 4, Y), drag(X, Y), release(X, Y))
		expect(since(mark)).toContain(osc('hello'))
	})

	it('keeps the selection inside the pane when the pointer leaves it', async () => {
		const { t, print, since, drive } = rig()
		await print(CONTENT)
		const mark = t.written.length
		await drive(press(X + 6, Y), drag(99, Y), release(99, Y))
		expect(since(mark)).toContain(osc('world'))
	})

	it('copies the wide characters once and no escape bytes', async () => {
		const { t, print, since, drive } = rig()
		await print('\x1b[31m日本語\x1b[0m ok')
		const mark = t.written.length
		await drive(press(X, Y), drag(X + 8, Y), release(X + 8, Y))
		expect(since(mark)).toContain(osc('日本語 ok'))
	})

	it('stays anchored to its lines while the wheel scrolls the history during a drag', async () => {
		const { t, print, since, drive } = rig()
		const lines = Array.from({ length: 40 }, (_, i) => `line${String(i).padStart(2, '0')}`)
		await print(lines.join('\r\n'))
		const mark = t.written.length
		// 40 lines in 29 rows: the top row shows line11. Three rows of history come back.
		await drive(press(X, Y), wheelUp(X, Y), drag(X + 5, Y), release(X + 5, Y))
		expect(since(mark)).toContain(osc('8\nline09\nline10\nl'))
	})

	it('copies nothing for a plain click or a selection of blanks', async () => {
		const { t, print, since, drive } = rig()
		await print(CONTENT)
		const mark = t.written.length
		await drive(press(X + 1, Y), release(X + 1, Y))
		await drive(press(X + 20, Y + 10), drag(X + 30, Y + 12), release(X + 30, Y + 12))
		expect(since(mark)).not.toContain(`${ESC}]52`)
	})

	it('picks a word on a double click and the whole line on a triple click', async () => {
		const { t, print, since, drive, clock } = rig()
		await print(CONTENT)
		const mark = t.written.length
		clock.now = 1000
		await drive(press(X + 8, Y), release(X + 8, Y))
		clock.now = 1100
		await drive(press(X + 8, Y), release(X + 8, Y))
		expect(since(mark)).toContain(osc('world'))
		const second = t.written.length
		clock.now = 1200
		await drive(press(X + 8, Y), release(X + 8, Y))
		expect(since(second)).toContain(osc('hello world'))
		// Too slow to be a double click: just a click, nothing copied.
		const third = t.written.length
		clock.now = 5000
		await drive(press(X + 8, Y), release(X + 8, Y))
		expect(since(third)).not.toContain(`${ESC}]52`)
	})

	it('picks a whole word and a whole line of wide characters', async () => {
		const { t, print, since, drive, clock } = rig()
		await print('ab \u4f60\u597d\u4e16\u754c cd')
		const mark = t.written.length
		clock.now = 1000
		// The second half of the third wide character.
		await drive(press(X + 8, Y), release(X + 8, Y))
		clock.now = 1100
		await drive(press(X + 8, Y), release(X + 8, Y))
		expect(since(mark)).toContain(osc('\u4f60\u597d\u4e16\u754c'))
		const second = t.written.length
		clock.now = 1200
		await drive(press(X + 8, Y), release(X + 8, Y))
		expect(since(second)).toContain(osc('ab \u4f60\u597d\u4e16\u754c cd'))
	})

	it('copies a wide character dragged from its second half', async () => {
		const { t, print, since, drive } = rig()
		await print('ab \u4f60\u597d\u4e16')
		const mark = t.written.length
		// Column 4 is the second half of the first wide character, column 5 the start of the next.
		await drive(press(X + 4, Y), drag(X + 5, Y), release(X + 5, Y))
		expect(since(mark)).toContain(osc('\u4f60\u597d'))
	})

	it('lets go of the selection on a key typed into the pane or on a resize', async () => {
		const { t, pty, print, since, drive } = rig({ copyOnSelect: false })
		await print(CONTENT)
		await drive(press(X, Y), drag(X + 4, Y), release(X + 4, Y))
		expect((await t.cellAt(X, Y))?.attrs ?? 0).toSatisfy((a: number) => (a & ATTR_INVERSE) !== 0)
		await drive('a')
		expect(pty.writes).toContain('a')
		expect((await t.cellAt(X, Y))?.attrs ?? 0).toSatisfy((a: number) => (a & ATTR_INVERSE) === 0)
		const mark = t.written.length
		await drive('\x03')
		expect(since(mark)).not.toContain(`${ESC}]52`)

		await drive(press(X, Y), drag(X + 4, Y), release(X + 4, Y))
		t.output.rows = 24
		for (const l of t.resizeListeners) l()
		await t.frame()
		expect((await t.cellAt(X, Y))?.attrs ?? 0).toSatisfy((a: number) => (a & ATTR_INVERSE) === 0)
	})
})

describe('copy on select turned off', () => {
	it('copies nothing on release, copies on ctrl+c, and lets go on the next one', async () => {
		const { t, pty, print, since, drive } = rig({ copyOnSelect: false })
		await print(CONTENT)
		const mark = t.written.length
		await drive(press(X, Y), drag(X + 4, Y), release(X + 4, Y))
		expect(since(mark)).not.toContain(`${ESC}]52`)
		expect((await t.screen()).join('\n')).toContain('Press ctrl+c to copy')
		await drive('\x03')
		expect(since(mark)).toContain(osc('hello'))
		await drive('\x03')
		expect(since(mark).split(`${ESC}]52`).length).toBe(2)
		expect(pty.writes).not.toContain('\x03')
		// With nothing selected ctrl+c belongs to the pane again.
		await drive('\x03')
		expect(pty.writes).toContain('\x03')
	})

	it('lets go on escape without sending it to the pane', async () => {
		const { t, pty, print, drive } = rig({ copyOnSelect: false })
		await print(CONTENT)
		await drive(press(X, Y), drag(X + 4, Y), release(X + 4, Y))
		await drive('\x1b')
		expect(pty.writes).not.toContain('\x1b')
		expect((await t.cellAt(X, Y))?.attrs ?? 0).toSatisfy((a: number) => (a & ATTR_INVERSE) === 0)
	})
})

describe('what the note says', () => {
	it('names Option for iTerm2 and the setting once', async () => {
		const { t, print, drive } = rig({ env: { TERM_PROGRAM: 'iTerm.app' } }, 140)
		await print(CONTENT)
		await drive(press(X, Y), drag(X + 4, Y), release(X + 4, Y))
		let shown = (await t.screen()).join('\n')
		expect(shown).toContain('Hold Option')
		expect(shown).toContain('tui.copyOnSelect')
		t.tick(2000)
		await drive(press(X, Y), drag(X + 4, Y), release(X + 4, Y))
		shown = (await t.screen()).join('\n')
		expect(shown).toContain('Hold Option')
	})

	it('wraps the request for tmux', async () => {
		const { t, print, since, drive } = rig({ env: { TMUX: '/tmp/tmux,1,0' } })
		await print(CONTENT)
		const mark = t.written.length
		await drive(press(X, Y), drag(X + 4, Y), release(X + 4, Y))
		expect(since(mark)).toContain(`${ESC}Ptmux;${ESC}${ESC}]52;c;${b64('hello')}${BEL}${ESC}\\`)
	})

	it('refuses a selection above the limit and says so', async () => {
		const { t, print, since, drive } = rig()
		const row = 'a'.repeat(74)
		await print(Array.from({ length: 1500 }, () => row).join('\r\n'))
		const mark = t.written.length
		// Back to the oldest line, press there, forward to the newest, then drag across it all.
		const wheels = Array.from({ length: 600 }, () => wheelUp(X, Y))
		await drive(...wheels)
		await drive(press(X, Y))
		await drive(...Array.from({ length: 600 }, () => wheelDown(X, Y)))
		await drive(drag(X + 73, Y + 28), release(X + 73, Y + 28))
		expect(since(mark)).not.toContain(`${ESC}]52`)
		expect((await t.screen()).join('\n')).toContain('too large to copy')
	})
})
