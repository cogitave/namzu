import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
	WINDOW_CAPTION_FILL,
	readWindowMenu,
	readWindowMenuAnchor,
	windowCaptionColors,
	windowChromeOptions,
} from './window-chrome.js'

describe('native window chrome', () => {
	it('draws the caption strip in the sidebar fill the menu row uses, in both themes', () => {
		const css = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8')
		const fill = (block: RegExp) => css.match(block)?.[1]?.toLowerCase()
		// `--chrome` must stay the sidebar's fill, and the strip must match that fill.
		expect(css.match(/--chrome:\s*var\(--sidebar\)/g)).toHaveLength(2)
		expect(fill(/:root \{[\s\S]*?--sidebar:\s*(#[0-9a-f]{6})/i)).toBe(WINDOW_CAPTION_FILL.light)
		expect(fill(/\.dark \{[\s\S]*?--sidebar:\s*(#[0-9a-f]{6})/i)).toBe(WINDOW_CAPTION_FILL.dark)
		expect(windowCaptionColors('dark').color).toBe(WINDOW_CAPTION_FILL.dark)
		expect(windowCaptionColors('light').color).toBe(WINDOW_CAPTION_FILL.light)
	})

	it('keeps native system controls instead of removing the operating system frame', () => {
		for (const platform of ['win32', 'linux', 'darwin']) {
			const options = windowChromeOptions(platform)
			expect(options.frame).toBeUndefined()
			expect(options.titleBarStyle).toBe('hidden')
			expect(options.titleBarOverlay).toMatchObject({ height: 32 })
		}
		expect(windowChromeOptions('darwin').trafficLightPosition).toEqual({
			x: 12,
			y: 9,
		})
	})
	it('rejects arbitrary appearance and menu commands at the main-process boundary', () => {
		for (const value of [undefined, null, {}, 'system', '#fff', '<script>'])
			expect(() => windowCaptionColors(value)).toThrow('Unknown window appearance')
		for (const value of [undefined, null, {}, 'open-project', 'quit', 'executeJavaScript'])
			expect(() => readWindowMenu(value)).toThrow('Unknown window menu')
	})
	it('keeps a menu anchored to its title bar control under renderer zoom', () => {
		expect(readWindowMenuAnchor({ x: 100, y: 32 }, { width: 800, height: 600, zoom: 1.5 })).toEqual(
			{ x: 150, y: 48 },
		)
	})
	it('refuses non-finite, negative and outside-window menu coordinates', () => {
		for (const position of [
			null,
			{ x: '12', y: 32 },
			{ x: Number.NaN, y: 32 },
			{ x: Number.POSITIVE_INFINITY, y: 32 },
			{ x: 0, y: -1 },
			{ x: 600, y: 32 },
			{ x: 100, y: 500 },
		])
			expect(() => readWindowMenuAnchor(position, { width: 800, height: 600, zoom: 1.5 })).toThrow(
				'Invalid window menu position',
			)
	})
})
