import { describe, expect, it, vi } from 'vitest'
import { TerminalSession, type TerminalSessionApi } from './terminal-session.js'

// The emulator measures a character cell when it opens and keeps that size, so a terminal must not
// open before its font face is ready. The face is a promise the test settles by hand: nothing here
// waits on a clock.

const api: TerminalSessionApi = {
	attachTerminal: () => new Promise(() => undefined),
	detachTerminal: () => Promise.resolve(),
	writeTerminal: () => Promise.resolve(),
	resizeTerminal: () => Promise.resolve(),
	onTerminalEvent: () => () => undefined,
}

function session(fontReady: Promise<unknown> | undefined) {
	const created = new TerminalSession(api, 'tab-1', {
		theme: {},
		fontFamily: '"Geist Mono", monospace',
		fontSize: 13,
		mac: false,
		fontReady,
		onFind: () => undefined,
	})
	const open = vi.spyOn(created.term, 'open').mockImplementation(() => undefined)
	return { created, open }
}

describe('a terminal and its font face', () => {
	it('does not open until the face is ready, then opens once in the last host given', async () => {
		let ready!: () => void
		const face = new Promise<void>((resolve) => {
			ready = resolve
		})
		const { created, open } = session(face)
		const first = {} as HTMLElement
		const second = {} as HTMLElement
		created.mount(first)
		created.mount(second)
		await Promise.resolve()
		expect(open).not.toHaveBeenCalled()
		ready()
		await face
		await Promise.resolve()
		expect(open).toHaveBeenCalledTimes(1)
		expect(open).toHaveBeenCalledWith(second)
		created.dispose()
	})

	it('opens at once when there is no face to wait for', () => {
		const { created, open } = session(undefined)
		created.mount({} as HTMLElement)
		expect(open).toHaveBeenCalledTimes(1)
		created.dispose()
	})

	it('opens even when the face never loads, because the wait ends on a rejection too', async () => {
		const face = Promise.reject(new Error('no face'))
		const { created, open } = session(face)
		created.mount({} as HTMLElement)
		await face.catch(() => undefined)
		await Promise.resolve()
		expect(open).toHaveBeenCalledTimes(1)
		created.dispose()
	})

	it('does not open a terminal that was closed while it waited', async () => {
		let ready!: () => void
		const face = new Promise<void>((resolve) => {
			ready = resolve
		})
		const { created, open } = session(face)
		created.mount({} as HTMLElement)
		created.dispose()
		ready()
		await face
		await Promise.resolve()
		expect(open).not.toHaveBeenCalled()
	})
})
