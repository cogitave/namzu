import { expect, it, vi } from 'vitest'

import { Composer } from '../Composer.js'
import { renderToScreen } from './support/screen.js'

it('assembles a fragmented terminal paste once, shows it as an inline chip and never submits its newlines', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	const prefix = 'İki subagent ile '
	const text = `${prefix}${'incele '.repeat(20)}\r\nSonuçları yaz 😀\r\nüç\r\ndört`
	const normalized = text.replace(/\r\n?/g, '\n')
	try {
		await screen.waitForRender()
		for (const chunk of ['\x1b[20', '0~', prefix, text.slice(prefix.length), '\x1b[201', '~']) {
			screen.press(chunk)
			await screen.waitForRender()
		}
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('❯ [Pasted text #1 +3 lines]')
		expect(frame).not.toContain('⎘')
		expect(frame).not.toContain('Pasted text #2')
		expect(frame).not.toContain(prefix)
		expect(frame).not.toContain('000d')
		expect(onSubmit).not.toHaveBeenCalled()
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			normalized,
			undefined,
			'submit',
			expect.objectContaining({ source: 'composer' }),
		)
	} finally {
		await screen.unmount()
	}
})

it('inserts a short paste at the cursor without interpreting a pasted return as submit', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	try {
		await screen.waitForRender()
		screen.press('ab')
		await screen.waitForRender()
		screen.press('\x1b[D')
		await screen.waitForRender()
		screen.press('\x1b[200~İ😀\x1b[201~')
		await screen.waitForRender()
		expect(onSubmit).not.toHaveBeenCalled()
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			'aİ😀b',
			undefined,
			'submit',
			expect.objectContaining({ source: 'composer' }),
		)
	} finally {
		await screen.unmount()
	}
})

it('submits a long paste even when Enter arrives before the next render', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	const pasted = `first line\nsecond line ${'x'.repeat(80)}\nthird\nfourth`
	try {
		await screen.waitForRender()
		screen.press(`\x1b[200~${pasted}\x1b[201~`)
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			pasted,
			undefined,
			'submit',
			expect.objectContaining({ source: 'composer' }),
		)
	} finally {
		await screen.unmount()
	}
})

it('keeps type-ahead that arrives in one long read as typed text, not a chip that splits a word', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	const typed = 'Delegate this to subag'
	const burst =
		'ents in two phases. Phase 1: two agents in parallel, each names one colour in a single word. Çok kısa tut.'
	try {
		await screen.waitForRender()
		screen.press(typed)
		await screen.waitForRender()
		// Keystrokes queued behind a busy render reach the composer as one chunk
		// with no bracketed-paste markers.
		screen.press(burst)
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('Pasted text')
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			`${typed}${burst}`,
			undefined,
			'submit',
			expect.objectContaining({ source: 'composer' }),
		)
	} finally {
		await screen.unmount()
	}
})

it('keeps a short multi-line paste as ordinary text', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	try {
		await screen.waitForRender()
		screen.press('\x1b[200~one\ntwo\nthree\x1b[201~')
		await screen.waitForRender()
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('two')
		expect(frame).not.toContain('Pasted text')
	} finally {
		await screen.unmount()
	}
})

it('holds a long one-line paste as a chip without a line count, between typed words', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	const pasted = 'y'.repeat(801)
	try {
		await screen.waitForRender()
		screen.press('see ')
		await screen.waitForRender()
		screen.press(`\x1b[200~${pasted}\x1b[201~`)
		await screen.waitForRender()
		screen.press(' now')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('see [Pasted text #1] now')
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			`see ${pasted} now`,
			undefined,
			'submit',
			expect.objectContaining({ source: 'composer' }),
		)
	} finally {
		await screen.unmount()
	}
})

it('removes a chip whole with one Backspace and sends nothing of it', async () => {
	const onSubmit = vi.fn()
	const screen = await renderToScreen(<Composer onSubmit={onSubmit} history={[]} />, {
		cols: 100,
		rows: 24,
	})
	try {
		await screen.waitForRender()
		screen.press('hi ')
		await screen.waitForRender()
		screen.press('\x1b[200~a\nb\nc\nd\x1b[201~')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('[Pasted text #1 +3 lines]')
		screen.press('\x7f')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('Pasted text')
		screen.press('\r')
		await screen.waitForRender()
		expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
			'hi',
			undefined,
			'submit',
			expect.objectContaining({ source: 'composer' }),
		)
	} finally {
		await screen.unmount()
	}
})

const queuedAvailable = {
	available: true,
	selected: false,
	onMove: () => false,
	onLoad: () => null,
	onLeave: () => {},
}
const queuedNone = { ...queuedAvailable, available: false }
const QUEUED_HINT_TEXT = 'Press up to edit queued messages'

/** A count held in memory, with every value written to it kept in order. */
function memoryCount(start: number) {
	const written: number[] = []
	let count = start
	return {
		written,
		store: {
			read: () => count,
			write: (next: number) => {
				count = next
				written.push(next)
			},
		},
	}
}

it('offers the queued-messages hint for its first three appearances and writes each one down', async () => {
	const { store, written } = memoryCount(0)
	const mount = (queuedEdit: typeof queuedNone) => (
		<Composer onSubmit={vi.fn()} history={[]} queuedEdit={queuedEdit} queuedHintCount={store} />
	)
	const screen = await renderToScreen(mount(queuedNone), { cols: 100, rows: 24 })
	const seen: boolean[] = []
	try {
		await screen.waitForRender()
		for (let i = 0; i < 4; i += 1) {
			screen.rerender(mount(queuedAvailable))
			await screen.waitForRender()
			seen.push(screen.viewport().join('\n').includes(QUEUED_HINT_TEXT))
			screen.rerender(mount(queuedNone))
			await screen.waitForRender()
		}
		expect(seen).toEqual([true, true, true, false])
		expect(written).toEqual([1, 2, 3])
		screen.rerender(mount(queuedAvailable))
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('Type a message')
	} finally {
		await screen.unmount()
	}
})

it('starts from the count kept by an earlier launch', async () => {
	const { store, written } = memoryCount(3)
	const screen = await renderToScreen(
		<Composer
			onSubmit={vi.fn()}
			history={[]}
			queuedEdit={queuedAvailable}
			queuedHintCount={store}
		/>,
		{ cols: 100, rows: 24 },
	)
	try {
		await screen.waitForRender()
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Type a message')
		expect(frame).not.toContain(QUEUED_HINT_TEXT)
		expect(written).toEqual([])
	} finally {
		await screen.unmount()
	}
})

it('never draws the plain placeholder before the hint it replaces', async () => {
	const { store } = memoryCount(0)
	const screen = await renderToScreen(
		<Composer
			onSubmit={vi.fn()}
			history={[]}
			queuedEdit={queuedAvailable}
			queuedHintCount={store}
		/>,
		{ cols: 100, rows: 24 },
	)
	try {
		await screen.waitForRender()
		const everything = screen.writes().join('')
		expect(everything).toContain(QUEUED_HINT_TEXT)
		expect(everything).not.toContain('Type a message')
	} finally {
		await screen.unmount()
	}
})
