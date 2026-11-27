import { describe, expect, it } from 'vitest'
import { GRAY_HEIGHT, GRAY_WIDTH } from './assembler.js'
import { drawRing, grayOf, isBlack, shownSize } from './pixels.js'

const solid = (width: number, height: number, value: number) => {
	const bgra = new Uint8Array(width * height * 4).fill(value)
	for (let at = 3; at < bgra.length; at += 4) bgra[at] = 255
	return bgra
}

describe('pixels', () => {
	it('reduces a picture to 64 x 36 brightness', () => {
		const gray = grayOf(solid(1280, 720, 100), 1280, 720)
		expect(gray).toHaveLength(GRAY_WIDTH * GRAY_HEIGHT)
		expect(new Set(gray)).toEqual(new Set([100]))
	})

	it('sees a bright block where one is drawn', () => {
		const bgra = solid(640, 360, 0)
		for (let y = 0; y < 180; y++)
			for (let x = 0; x < 320; x++) bgra.fill(255, (y * 640 + x) * 4, (y * 640 + x) * 4 + 3)
		const gray = grayOf(bgra, 640, 360)
		expect(gray[0]).toBeGreaterThan(200)
		expect(gray[GRAY_WIDTH * GRAY_HEIGHT - 1]).toBe(0)
	})

	it('knows an all-black picture, and not a dim one', () => {
		expect(isBlack(grayOf(solid(64, 36, 0), 64, 36))).toBe(true)
		expect(isBlack(grayOf(solid(64, 36, 20), 64, 36))).toBe(false)
	})

	it('draws a ring around the point and leaves the middle and the far corners alone', () => {
		const bgra = solid(100, 100, 0)
		drawRing(bgra, 100, 100, 50, 50)
		const at = (x: number, y: number) => bgra[(y * 100 + x) * 4 + 2]
		expect(at(64, 50)).toBe(235)
		expect(at(50, 50)).toBe(0)
		expect(at(0, 0)).toBe(0)
	})

	it('draws nothing for a point off the picture and clips one at the edge', () => {
		const bgra = solid(50, 50, 0)
		drawRing(bgra, 50, 50, 500, 500)
		expect(bgra.every((value, index) => (index % 4 === 3 ? value === 255 : value === 0))).toBe(true)
		expect(() => drawRing(bgra, 50, 50, 0, 0)).not.toThrow()
	})

	it('scales a display down to a long edge and never up', () => {
		expect(shownSize(2560, 1440, 1280)).toEqual({ w: 1280, h: 720 })
		expect(shownSize(1280, 720, 1280)).toEqual({ w: 1280, h: 720 })
		expect(shownSize(800, 600, 1280)).toEqual({ w: 800, h: 600 })
		expect(shownSize(1080, 1920, 1280)).toEqual({ w: 720, h: 1280 })
	})
})

describe('the tray dot', () => {
	it('is red in the middle and clear at the corners', async () => {
		const { redDot } = await import('./pixels.js')
		const dot = redDot(16)
		const at = (x: number, y: number) => (y * 16 + x) * 4
		expect(dot[at(8, 8) + 2]).toBe(225)
		expect(dot[at(8, 8) + 3]).toBe(255)
		expect(dot[at(0, 0) + 3]).toBe(0)
	})
})
