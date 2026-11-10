import { describe, expect, it, vi } from 'vitest'
import { overlayBitmap } from './attention-overlay.js'
import { AttentionSignals, type AttentionWindow } from './attention-signals.js'

function makeWindow(calls: string[], name = '') {
	return {
		focused: false,
		destroyed: false,
		isDestroyed() {
			return this.destroyed
		},
		isFocused() {
			return this.focused
		},
		flashFrame(flash: boolean) {
			calls.push(`${name}flash:${flash}`)
		},
		setOverlayIcon(image: unknown, description: string) {
			calls.push(`${name}overlay:${image === null ? 'none' : 'icon'}:${description}`)
		},
	}
}

function setup(platform: NodeJS.Platform, enabled = { value: true }) {
	const calls: string[] = []
	const window = makeWindow(calls)
	const extra: ReturnType<typeof makeWindow>[] = []
	const signals = new AttentionSignals({
		platform,
		windows: () => [window as AttentionWindow, ...(extra as AttentionWindow[])],
		setBadgeCount: (count) => calls.push(`badge:${count}`),
		bounceDock: () => {
			calls.push('bounce')
			return 7
		},
		cancelDockBounce: (id) => calls.push(`cancel:${id}`),
		overlayImage: () => ({}),
		enabled: () => enabled.value,
	})
	const second = (name: string) => {
		const w = makeWindow(calls, name)
		extra.push(w)
		return w
	}
	return { calls, window, signals, enabled, second }
}

describe('AttentionSignals', () => {
	it('sets the badge and bounces once on macOS, then clears on focus', () => {
		const { calls, window, signals } = setup('darwin')
		signals.update(['a'])
		signals.update(['a', 'b'])
		signals.update(['a', 'b'])
		expect(calls).toEqual(['badge:1', 'bounce', 'badge:2'])
		calls.length = 0
		window.focused = true
		signals.refresh()
		expect(calls).toEqual(['badge:0', 'cancel:7'])
	})

	it('uses the overlay and one flash on Windows and never the badge count', () => {
		const { calls, window, signals } = setup('win32')
		signals.update(['a'])
		signals.update(['a', 'b'])
		expect(calls).toEqual([
			'overlay:icon:1 conversation needs you',
			'flash:true',
			'overlay:icon:2 conversations need you',
		])
		calls.length = 0
		window.focused = true
		signals.refresh()
		expect(calls).toEqual(['overlay:none:', 'flash:false'])
	})

	it('flashes again only after the need went away and came back', () => {
		const { calls, signals } = setup('win32')
		signals.update(['a'])
		signals.update([])
		calls.length = 0
		signals.update(['b'])
		expect(calls).toContain('flash:true')
		expect(calls.filter((c) => c === 'flash:true')).toHaveLength(1)
	})

	it('shows nothing while a window is focused and signals when focus is lost', () => {
		const { calls, window, signals } = setup('darwin')
		window.focused = true
		signals.update(['a'])
		expect(calls).toEqual([])
		window.focused = false
		signals.refresh()
		expect(calls).toEqual(['badge:1', 'bounce'])
	})

	it('lets go when the setting is turned off and does nothing while it is off', () => {
		const { calls, signals, enabled } = setup('darwin')
		signals.update(['a'])
		calls.length = 0
		enabled.value = false
		signals.refresh()
		expect(calls).toEqual(['badge:0', 'cancel:7'])
		calls.length = 0
		signals.update(['a', 'b'])
		expect(calls).toEqual([])
	})

	it('clears when nothing needs the person, and ignores a destroyed window', () => {
		const { calls, window, signals } = setup('win32')
		signals.update(['a'])
		window.destroyed = true
		calls.length = 0
		signals.update([])
		expect(calls).toEqual([])
	})
})

describe('AttentionSignals windows and edges', () => {
	it('does not flash while switching between two windows', () => {
		vi.useFakeTimers()
		try {
			const { calls, window, signals, second } = setup('darwin')
			const other = second('b:')
			window.focused = true
			signals.update(['a'])
			window.focused = false
			signals.windowBlurred()
			other.focused = true
			vi.advanceTimersByTime(100)
			expect(calls).toEqual([])
		} finally {
			vi.useRealTimers()
		}
	})

	it('signals after a blur that leaves no window focused', () => {
		vi.useFakeTimers()
		try {
			const { calls, window, signals } = setup('darwin')
			window.focused = true
			signals.update(['a'])
			window.focused = false
			signals.windowBlurred()
			expect(calls).toEqual([])
			vi.advanceTimersByTime(100)
			expect(calls).toEqual(['badge:1', 'bounce'])
		} finally {
			vi.useRealTimers()
		}
	})

	it('stays quiet when one window is focused and another is not', () => {
		const { calls, signals, second } = setup('darwin')
		second('b:').focused = true
		signals.update(['a'])
		expect(calls).toEqual([])
	})

	it('does nothing on a focus change when the count is unchanged', () => {
		const { calls, signals } = setup('darwin')
		signals.update(['a'])
		calls.length = 0
		signals.refresh()
		signals.refresh()
		expect(calls).toEqual([])
	})

	it('stamps a window opened while the signal is active', () => {
		const { calls, signals, second } = setup('win32')
		signals.update(['a'])
		calls.length = 0
		second('b:')
		signals.refresh()
		expect(calls).toContain('b:overlay:icon:1 conversation needs you')
		calls.length = 0
		signals.refresh()
		expect(calls).toEqual([])
	})

	it('passes the overlay image to setOverlayIcon', () => {
		const images: unknown[] = []
		const image = { bitmap: true }
		const signals = new AttentionSignals({
			platform: 'win32',
			windows: () => [
				{
					isDestroyed: () => false,
					isFocused: () => false,
					flashFrame: () => {},
					setOverlayIcon: (img) => images.push(img),
				},
			],
			setBadgeCount: () => {},
			overlayImage: () => image,
			enabled: () => true,
		})
		signals.update(['a'])
		expect(images).toEqual([image])
	})

	it('signals again when the setting comes back on while the need remains', () => {
		const { calls, signals, enabled } = setup('darwin')
		signals.update(['a'])
		enabled.value = false
		signals.refresh()
		calls.length = 0
		enabled.value = true
		signals.refresh()
		expect(calls).toEqual(['badge:1', 'bounce'])
	})

	it('passes an absent dock bounce through without cancelling anything', () => {
		const cancelled: number[] = []
		const signals = new AttentionSignals({
			platform: 'darwin',
			windows: () => [],
			setBadgeCount: () => {},
			bounceDock: () => undefined,
			cancelDockBounce: (id) => cancelled.push(id),
			enabled: () => true,
		})
		signals.update(['a'])
		signals.update([])
		expect(cancelled).toEqual([])
	})
})

it('draws a 16 by 16 overlay whose pixels differ by count', () => {
	const one = overlayBitmap(1)
	expect(one.data.length).toBe(16 * 16 * 4)
	expect(overlayBitmap(2).data.equals(one.data)).toBe(false)
	expect(overlayBitmap(12).data.equals(overlayBitmap(99).data)).toBe(true)
})
