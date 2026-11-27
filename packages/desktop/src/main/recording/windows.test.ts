import { describe, expect, it } from 'vitest'
import { PILL_HEIGHT, PILL_WIDTH } from './pages.js'

// The window classes need Electron; the pure helpers are tested through the module-level names.
// Electron is not available under vitest, so the helpers are loaded through a stub.
import { vi } from 'vitest'
vi.mock('electron', () => ({ BrowserWindow: class {}, ipcMain: { on() {}, removeListener() {} } }))
const { ChooserGate, pillBounds, pointerNear, readChooserAnswer, readPillAction } = await import(
	'./windows.js'
)

describe('the chooser gate', () => {
	it('ignores Start for 300 ms after the chooser opens, and Cancel never', () => {
		let now = 1_000
		const gate = new ChooserGate(() => now, 300)
		const start = { type: 'start', displayId: '1', voice: false, microphone: '' } as const
		expect(gate.accept(start)).toBeUndefined()
		expect(gate.accept({ type: 'cancel' })).toEqual({ type: 'cancel' })
		now = 1_299
		expect(gate.accept(start)).toBeUndefined()
		now = 1_300
		expect(gate.accept(start)).toEqual(start)
	})
})

describe('what the chooser and the pill may say', () => {
	it('reads a start answer key by key', () => {
		expect(
			readChooserAnswer({ type: 'start', displayId: '2', voice: true, microphone: 'mic-1' }),
		).toEqual({
			type: 'start',
			displayId: '2',
			voice: true,
			microphone: 'mic-1',
		})
		expect(
			readChooserAnswer({ type: 'start', displayId: 2, voice: true, microphone: '' }),
		).toBeUndefined()
		expect(
			readChooserAnswer({ type: 'start', displayId: '2', voice: 'yes', microphone: '' }),
		).toBeUndefined()
		expect(readChooserAnswer({ type: 'delete everything' })).toBeUndefined()
		expect(readChooserAnswer(null)).toBeUndefined()
		expect(readChooserAnswer({ type: 'cancel', extra: 1 })).toEqual({ type: 'cancel' })
	})

	it('reads only the five pill actions', () => {
		for (const type of ['pause', 'resume', 'done', 'discard', 'reconnect'])
			expect(readPillAction({ type })).toBe(type)
		expect(readPillAction({ type: 'quit' })).toBeUndefined()
		expect(readPillAction('done')).toBeUndefined()
	})
})

describe('where the pill sits', () => {
	const display = { workArea: { x: 0, y: 0, width: 2560, height: 1400 } }
	it('is at the top centre, and at the bottom while the pointer is near the top', () => {
		const top = pillBounds(display, false)
		expect(top).toEqual({
			x: (2560 - PILL_WIDTH) / 2,
			y: 10,
			width: PILL_WIDTH,
			height: PILL_HEIGHT,
		})
		const bottom = pillBounds(display, true)
		expect(bottom.y).toBe(1400 - PILL_HEIGHT - 12)
	})

	it('notices a pointer near it and not one far away', () => {
		const rect = pillBounds(display, false)
		expect(pointerNear({ x: rect.x + 10, y: 100 }, rect)).toBe(true)
		expect(pointerNear({ x: 100, y: 700 }, rect)).toBe(false)
	})
})
