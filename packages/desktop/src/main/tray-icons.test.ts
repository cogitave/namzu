import { describe, expect, it } from 'vitest'
import { trayRepresentations, trayTheme } from './tray-icons.js'

const PNG_SIGNATURE = '89504e470d0a1a0a'

function dimensions(png: Buffer): [number, number] {
	return [png.readUInt32BE(16), png.readUInt32BE(20)]
}

describe('Namzu tray mark pictures', () => {
	it('draws Windows at 16 points for the four common screen scales', () => {
		const reps = trayRepresentations('win32', 'dark')
		expect(reps.map((r) => [r.scaleFactor, r.size])).toEqual([
			[1, 16],
			[1.25, 20],
			[1.5, 24],
			[2, 32],
		])
	})

	it('uses 24 points with a double picture on the other systems', () => {
		for (const platform of ['linux', 'darwin']) {
			expect(trayRepresentations(platform, 'light').map((r) => [r.scaleFactor, r.size])).toEqual([
				[1, 24],
				[2, 48],
			])
		}
	})

	it('hands back real pictures of exactly the stated size in both themes', () => {
		for (const theme of ['dark', 'light'] as const) {
			for (const platform of ['win32', 'linux']) {
				for (const rep of trayRepresentations(platform, theme)) {
					expect(rep.png.subarray(0, 8).toString('hex')).toBe(PNG_SIGNATURE)
					expect(dimensions(rep.png)).toEqual([rep.size, rep.size])
				}
			}
		}
	})

	it('has a different picture for each theme', () => {
		const dark = trayRepresentations('win32', 'dark')[0]?.png.toString('base64')
		const light = trayRepresentations('win32', 'light')[0]?.png.toString('base64')
		expect(dark).not.toBe(light)
	})

	it('maps the system theme to a tile', () => {
		expect(trayTheme(true)).toBe('dark')
		expect(trayTheme(false)).toBe('light')
	})
})
