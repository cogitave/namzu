import { describe, expect, it } from 'vitest'
import {
	readWindowMenu,
	readWindowMenuAnchor,
	windowCaptionColors,
	windowChromeOptions,
} from './window-chrome.js'

describe('native window chrome', () => {
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
