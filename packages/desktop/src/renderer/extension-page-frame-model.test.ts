import { describe, expect, it } from 'vitest'
import { boundsOf, sameBounds, themeTokens } from './extension-page-frame-model.js'

describe('the frame of an extension page', () => {
	it("copies the app's tokens to the names a page may use, and skips what is not defined", () => {
		const css: Record<string, string> = {
			'--background': ' #ffffff ',
			'--foreground': '#111',
			'--muted-foreground': '#777',
			'--border': '#ddd',
			'--primary': '#2F6F4F',
			'--font-sans': 'Geist, sans-serif',
			'--radius': '0.625rem',
		}
		expect(themeTokens((n) => css[n] ?? '')).toEqual({
			'--ns-bg': '#ffffff',
			'--ns-surface': '#ffffff',
			'--ns-fg': '#111',
			'--ns-muted': '#777',
			'--ns-border': '#ddd',
			'--ns-accent': '#2F6F4F',
			'--ns-font': 'Geist, sans-serif',
			'--ns-radius': '0.625rem',
		})
		expect(themeTokens(() => '')).toEqual({})
	})
	it('reports whole pixels and never a negative size', () => {
		expect(boundsOf({ left: 10.4, top: 20.6, width: 300.5, height: -3 })).toEqual({
			x: 10,
			y: 21,
			width: 301,
			height: 0,
		})
		expect(
			sameBounds({ x: 1, y: 2, width: 3, height: 4 }, { x: 1, y: 2, width: 3, height: 4 }),
		).toBe(true)
		expect(sameBounds(undefined, { x: 1, y: 2, width: 3, height: 4 })).toBe(false)
	})
	it('cuts the view to the visible part of a scrolling dialog and hides it when nothing is visible', () => {
		const slot = { left: 100, top: 300, width: 400, height: 360 }
		// the dialog body shows y 120..520 of the window; the strip above it is y 60..120
		const body = { left: 80, top: 120, width: 440, height: 400 }
		const win = { left: 0, top: 0, width: 1000, height: 700 }
		expect(boundsOf(slot, [win, body])).toEqual({
			x: 100,
			y: 300,
			width: 400,
			height: 220,
		})
		// scrolled so that the slot starts above the body: the top is cut, never drawn over the strip
		expect(boundsOf({ ...slot, top: 40 }, [win, body])).toEqual({
			x: 100,
			y: 120,
			width: 400,
			height: 280,
		})
		// scrolled out of sight
		expect(boundsOf({ ...slot, top: -500 }, [win, body])).toMatchObject({
			width: 0,
			height: 0,
		})
		// the window itself clips too
		expect(boundsOf({ ...slot, left: 900 }, [win])).toMatchObject({
			x: 900,
			width: 100,
		})
	})
	it('gives the view no area while one of the own overlays lies over the slot', () => {
		const slot = { left: 100, top: 300, width: 400, height: 360 }
		const toast = { left: 300, top: 600, width: 300, height: 60 }
		expect(boundsOf(slot, [], [toast])).toMatchObject({ width: 0, height: 0 })
		expect(boundsOf(slot, [], [{ left: 700, top: 0, width: 50, height: 50 }])).toEqual({
			x: 100,
			y: 300,
			width: 400,
			height: 360,
		})
	})
})
