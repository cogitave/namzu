import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
	TRAFFIC_LIGHT_POSITION,
	WINDOW_CAPTION_FILL,
	WINDOW_CHROME_HEIGHT,
	drawsMenuButton,
	windowCaptionColors,
	windowChrome,
	windowChromeOptions,
} from './window-chrome.js'

describe('native window chrome', () => {
	it('draws the window buttons in the sidebar fill, one band with the header, in both themes', () => {
		const css = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8')
		const fill = (block: RegExp) => css.match(block)?.[1]?.toLowerCase()
		// `--chrome` must stay the sidebar's fill, and the buttons must match that fill.
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
			expect(options.titleBarOverlay).toMatchObject({ height: 36 })
		}
	})
	it('rejects arbitrary appearance values at the main-process boundary', () => {
		for (const value of [undefined, null, {}, 'system', '#fff', '<script>'])
			expect(() => windowCaptionColors(value)).toThrow('Unknown window appearance')
	})
	it('makes the window buttons as high as the header band, so they end the same band', () => {
		const css = readFileSync(new URL('../renderer/theme.css', import.meta.url), 'utf8')
		const band = Number(/--frame-header-height:\s*(\d+)px/.exec(css)?.[1])
		expect(WINDOW_CHROME_HEIGHT).toBe(band)
		expect(WINDOW_CHROME_HEIGHT).toBe(36)
		for (const platform of ['win32', 'linux', 'darwin'])
			expect(windowChromeOptions(platform).titleBarOverlay).toMatchObject({ height: 36 })
		expect(windowCaptionColors('light').height).toBe(36)
		expect(windowChrome('linux').height).toBe(36)
	})
	it('centres the macOS traffic lights in the band', () => {
		expect(TRAFFIC_LIGHT_POSITION).toEqual({ x: 12, y: 12 })
		expect(windowChromeOptions('win32').trafficLightPosition).toBeUndefined()
	})
	it('draws the header menu button everywhere but on macOS, which keeps the system menu bar', () => {
		expect(drawsMenuButton('win32')).toBe(true)
		expect(drawsMenuButton('linux')).toBe(true)
		expect(drawsMenuButton('freebsd')).toBe(true)
		expect(drawsMenuButton('darwin')).toBe(false)
	})
})
