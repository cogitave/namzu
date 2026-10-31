import { describe, expect, it } from 'vitest'
import { RGB_FLAG, rgb } from '../../terminal/host/cell.js'
import { advertisesTruecolor, nearestAnsi, paletteFor } from '../palette.js'

describe('the palette', () => {
	it('is true colour where the terminal says so', () => {
		const palette = paletteFor(true)
		expect(palette.accent).toBe(rgb(137, 180, 250))
		expect(palette.dim).toBe(rgb(108, 112, 134))
		expect(palette.panelBg).toBe(rgb(24, 24, 37))
		expect(palette.activeRow).toBe(rgb(30, 30, 46))
		expect(palette.cursorRow).toBe(rgb(49, 50, 68))
	})

	it('falls back to the nearest of the 16 colours elsewhere', () => {
		const palette = paletteFor(false)
		for (const [name, value] of Object.entries(palette)) {
			// The faint tint is left out in 16 colours, which is the terminal's own background.
			if (name === 'activeRow') {
				expect(value).toBe(-1)
				continue
			}
			expect(value).toBeGreaterThanOrEqual(0)
			expect(value).toBeLessThan(16)
			expect(value & RGB_FLAG).toBe(0)
		}
		expect(nearestAnsi([0, 0, 0])).toBe(0)
		expect(nearestAnsi([255, 255, 255])).toBe(15)
		expect(nearestAnsi([250, 10, 10])).toBe(9)
		// Dim grey is not read as black or white.
		expect([7, 8]).toContain(palette.dim)
	})

	it('keeps a resting tab apart from the bar in 16 colours, and its text readable', () => {
		const palette = paletteFor(false)
		expect(palette.surface).not.toBe(palette.panelBg)
		expect(palette.tabRest).not.toBe(palette.surface)
		const full = paletteFor(true)
		expect(full.tabRest).toBe(full.dim)
	})

	it('reads COLORTERM', () => {
		expect(advertisesTruecolor({ COLORTERM: 'truecolor' })).toBe(true)
		expect(advertisesTruecolor({ COLORTERM: '24BIT' })).toBe(true)
		expect(advertisesTruecolor({ COLORTERM: 'yes' })).toBe(false)
		expect(advertisesTruecolor({})).toBe(false)
	})
})
