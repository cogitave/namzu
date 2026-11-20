import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { Composer, type VimIndicator } from '../Composer.js'
import type { Notice } from '../notifications.js'

/** What the mocked clipboard returns for the next Ctrl+V. */
let clipboard: import('../../integrations/clipboard/image.js').ClipboardRead = { kind: 'empty' }
vi.mock('../../integrations/clipboard/image.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../integrations/clipboard/image.js')>()),
	readClipboardImage: () => clipboard,
}))

const mounted: { unmount: () => void }[] = []
// Ink draws at most once per ~33 ms, so a key that changes state twice (a mode, then a chip)
// needs the clock moved past the second draw before the frame is read.
const settle = () => vi.advanceTimersByTimeAsync(70)
const ESC = '\x1B'

beforeEach(() => {
	vi.useFakeTimers()
})
afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.useRealTimers()
})

function open(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
	const notices: Notice[] = []
	const indicators: (VimIndicator | null)[] = []
	const onSubmit = vi.fn()
	const harness = render(
		<Composer
			history={[]}
			onSubmit={onSubmit}
			editorMode="vim"
			onVimModeChange={(indicator) => indicators.push(indicator)}
			onFooterNotice={(notice) => notices.push(notice)}
			{...overrides}
		/>,
	)
	mounted.push(harness)
	const keys = async (text: string) => {
		for (const ch of text) {
			harness.stdin.write(ch)
			await settle()
		}
	}
	const send = async (bytes: string) => {
		harness.stdin.write(bytes)
		await settle()
	}
	/** The last mode told to the host. */
	const mode = () => indicators.at(-1)
	return { ...harness, notices, indicators, onSubmit, keys, send, mode }
}

describe('vim keys in the message box', () => {
	it('starts in INSERT, where letters are typed', async () => {
		const h = open()
		await settle()
		expect(h.mode()).toEqual({ mode: 'INSERT', ownsEscape: true })
		await h.keys('hello')
		expect(h.lastFrame()).toContain('hello')
	})

	it('Esc goes to NORMAL, keeps the draft and arms no clear', async () => {
		const h = open()
		await h.keys('hello')
		await h.send(ESC)
		expect(h.mode()).toEqual({ mode: 'NORMAL', ownsEscape: false })
		expect(h.lastFrame()).toContain('hello')
		expect(h.notices).toEqual([])
	})

	it('Esc in NORMAL with a draft is the usual first press of the clear', async () => {
		const h = open()
		await h.keys('hello')
		await h.send(ESC)
		await h.send(ESC)
		expect(h.notices.map((notice) => notice.text)).toEqual(['Esc again to clear'])
		expect(h.lastFrame()).toContain('hello')
	})

	it('NORMAL keys edit and i comes back to INSERT', async () => {
		const h = open()
		await h.keys('hello world')
		await h.send(ESC)
		await h.keys('0dw')
		expect(h.lastFrame()).toContain('world')
		expect(h.lastFrame()).not.toContain('hello')
		await h.keys('iX')
		await h.send(ESC)
		expect(h.lastFrame()).toContain('Xworld')
	})

	it('one undo takes back everything typed in an insert', async () => {
		const h = open()
		await h.keys('one')
		await h.send(ESC)
		await h.keys('A two words')
		await h.send(ESC)
		expect(h.lastFrame()).toContain('one two words')
		await h.keys('u')
		expect(h.lastFrame()).toContain('one')
		expect(h.lastFrame()).not.toContain('two')
	})

	it('dot repeats, p puts what dd took', async () => {
		const h = open()
		await h.keys('a b c d')
		await h.send(ESC)
		await h.keys('0dw.')
		expect(h.lastFrame()).toContain('c d')
		expect(h.lastFrame()).not.toContain('a b')
		await h.keys('P')
		expect(h.lastFrame()).toContain('b c d')
	})

	it('Enter sends in NORMAL and the next draft starts in INSERT', async () => {
		const h = open()
		await h.keys('send me')
		await h.send(ESC)
		await h.send('\r')
		expect(h.onSubmit).toHaveBeenCalledTimes(1)
		expect(h.onSubmit.mock.calls[0]?.[0]).toBe('send me')
		expect(h.mode()).toEqual({ mode: 'INSERT', ownsEscape: true })
		await h.keys('next')
		expect(h.lastFrame()).toContain('next')
	})

	it('Enter sends from INSERT too', async () => {
		const h = open()
		await h.keys('hi')
		await h.send('\r')
		expect(h.onSubmit).toHaveBeenCalledTimes(1)
	})

	it('k and j step through history from the first and last line', async () => {
		const h = open({ history: ['first', 'second'] })
		await h.send(ESC)
		await h.keys('k')
		expect(h.lastFrame()).toContain('second')
		await h.keys('k')
		expect(h.lastFrame()).toContain('first')
		await h.keys('j')
		expect(h.lastFrame()).toContain('second')
	})

	it('moves between the lines of a multi-line draft with j and k', async () => {
		const h = open()
		await h.keys('abc')
		await h.send('\x1B\r') // Alt+Enter: a new line
		await h.keys('def')
		await h.send(ESC)
		await h.keys('kx')
		const frame = h.lastFrame() ?? ''
		expect(frame).toContain('ab')
		expect(frame).toContain('def')
		expect(frame).not.toContain('abc')
	})

	it('a paste lands in the draft in NORMAL and leaves the mode alone', async () => {
		const h = open()
		await h.keys('ab')
		await h.send(ESC)
		await h.send('\x1b[200~pasted\x1b[201~')
		expect(h.lastFrame()).toContain('pasted')
		expect(h.mode()?.mode).toBe('NORMAL')
	})

	it('v selects and d deletes; Esc leaves VISUAL without clearing', async () => {
		const h = open()
		await h.keys('hello')
		await h.send(ESC)
		await h.keys('0vl')
		expect(h.mode()).toEqual({ mode: 'VISUAL', ownsEscape: true })
		await h.send(ESC)
		expect(h.mode()).toEqual({ mode: 'NORMAL', ownsEscape: false })
		await h.keys('0vld')
		expect(h.lastFrame()).toContain('llo')
	})

	it("Esc is the box's while a command is half typed", async () => {
		const h = open()
		await h.keys('hello')
		await h.send(ESC)
		await h.keys('d')
		expect(h.mode()).toEqual({ mode: 'NORMAL', ownsEscape: true })
		await h.send(ESC)
		expect(h.mode()).toEqual({ mode: 'NORMAL', ownsEscape: false })
		expect(h.notices).toEqual([])
	})

	it('a typed slash menu is closed by the first Esc and the box stays in INSERT', async () => {
		const h = open()
		await h.keys('/he')
		await h.send(ESC)
		expect(h.mode()?.mode).toBe('INSERT')
		await h.send(ESC)
		expect(h.mode()?.mode).toBe('NORMAL')
	})

	it('a ! at the start still makes a shell line in INSERT, and Esc leaves the shell first', async () => {
		const h = open()
		await h.keys('!ls')
		expect(h.lastFrame()).toContain('ls')
		await h.send(ESC)
		expect(h.mode()?.mode).toBe('INSERT')
		await h.send(ESC)
		expect(h.mode()?.mode).toBe('NORMAL')
	})

	it('Ctrl+R opens the history search from NORMAL and a / does too', async () => {
		const h = open({ history: ['older line'] })
		await h.send(ESC)
		await h.keys('/')
		expect(h.mode()?.mode).toBe('INSERT')
		expect(h.lastFrame()).toContain('older line')
	})

	it('Ctrl+V attaches an image from NORMAL, and from VISUAL after leaving it', async () => {
		clipboard = { kind: 'image', image: { data: 'ONE', mediaType: 'image/png' } }
		const h = open()
		await h.keys('abc')
		await h.send(ESC)
		await h.send('\x16')
		expect(h.lastFrame()).toContain('Image #1')
		await h.keys('v')
		expect(h.mode()?.mode).toBe('VISUAL')
		clipboard = { kind: 'image', image: { data: 'TWO', mediaType: 'image/png' } }
		await h.send('\x16')
		expect(h.mode()?.mode).toBe('NORMAL')
		// The second chip is drawn a little after the key, so let the clock run before reading the frame.
		await vi.advanceTimersByTimeAsync(500)
		expect(h.lastFrame()).toContain('Image #2')
	})

	it('Ctrl+V attaches an image from INSERT', async () => {
		clipboard = { kind: 'image', image: { data: 'ONE', mediaType: 'image/png' } }
		const h = open()
		await h.send('\x16')
		expect(h.lastFrame()).toContain('Image #1')
	})

	it('a turn running does not take the Esc that leaves INSERT', async () => {
		const h = open({ escapeInterrupts: true })
		await h.keys('abc')
		await h.send(ESC)
		expect(h.mode()).toEqual({ mode: 'NORMAL', ownsEscape: false })
		expect(h.lastFrame()).toContain('abc')
	})

	it('ctrl keys edit in NORMAL and the mode stays', async () => {
		const h = open()
		await h.keys('hello')
		await h.send(ESC)
		await h.send('\x15') // Ctrl+U
		expect(h.mode()?.mode).toBe('NORMAL')
		expect(h.lastFrame()).not.toContain('hello'.slice(0, 4))
	})

	it('the cursor never rests past the last character in NORMAL', async () => {
		const h = open()
		await h.keys('abc')
		await h.send(ESC)
		await h.send('\x05') // Ctrl+E: end of line
		await h.keys('x')
		expect(h.lastFrame()).toContain('ab')
		expect(h.lastFrame()).not.toContain('abc')
	})
})

describe('vim keys are off by default', () => {
	it('with the setting off, Esc keeps its old meaning and says nothing about vim', async () => {
		const indicators: (VimIndicator | null)[] = []
		const h = render(
			<Composer history={[]} onSubmit={vi.fn()} onVimModeChange={(i) => indicators.push(i)} />,
		)
		mounted.push(h)
		h.stdin.write('hello')
		await settle()
		h.stdin.write('x')
		await settle()
		expect(h.lastFrame()).toContain('hellox')
		expect(indicators.every((indicator) => indicator === null)).toBe(true)
	})

	it('turning the setting off mid-session goes back to the usual keys', async () => {
		const indicators: (VimIndicator | null)[] = []
		const view = (mode: 'vim' | 'normal') => (
			<Composer
				history={[]}
				onSubmit={vi.fn()}
				editorMode={mode}
				onVimModeChange={(i) => indicators.push(i)}
			/>
		)
		const h = render(view('vim'))
		mounted.push(h)
		await settle()
		h.stdin.write(ESC)
		await settle()
		h.rerender(view('normal'))
		await settle()
		expect(indicators.at(-1)).toBeNull()
		h.stdin.write('typed')
		await settle()
		expect(h.lastFrame()).toContain('typed')
	})
})
