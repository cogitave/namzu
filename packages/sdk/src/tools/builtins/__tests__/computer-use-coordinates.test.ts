import { describe, expect, it } from 'vitest'
import type { DisplayInfo } from '../../../types/computer-use/index.js'
import {
	type ScreenshotFrame,
	ScreenshotFrames,
	assumedDisplay,
	desktopRectOnImage,
	pointOnImage,
	toDisplayPoint,
	toDisplayRect,
	toImagePoint,
} from '../computer-use-coordinates.js'
import { screenshotTargetSize } from '../computer-use-image.js'

function frameOf(display: DisplayInfo): ScreenshotFrame {
	const image = screenshotTargetSize(display.width, display.height)
	return new ScreenshotFrames().record(image, display)
}

const ULTRAWIDE: DisplayInfo = {
	id: '0',
	x: 0,
	y: 0,
	width: 3440,
	height: 1440,
	scaleFactor: 1,
	primary: true,
}

describe('mapping model coordinates onto the display', () => {
	it('round-trips every pixel of the 3440x1440 screenshot exactly', () => {
		const frame = frameOf(ULTRAWIDE)
		expect([frame.imageWidth, frame.imageHeight]).toEqual([1568, 656])
		for (let x = 0; x < frame.imageWidth; x += 1) {
			const display = toDisplayPoint(frame, { x, y: 0 })
			expect(toImagePoint(frame, display).x).toBe(x)
		}
		for (let y = 0; y < frame.imageHeight; y += 1) {
			const display = toDisplayPoint(frame, { x: 0, y })
			expect(toImagePoint(frame, display).y).toBe(y)
		}
	})

	it('lands a click within one screenshot pixel of what the model saw', () => {
		const frame = frameOf(ULTRAWIDE)
		const scaleX = ULTRAWIDE.width / frame.imageWidth
		const scaleY = ULTRAWIDE.height / frame.imageHeight
		// A target on the real display, read off the screenshot by the model
		// and clicked: the click must fall inside the screenshot pixel that
		// showed it — within 1 px of the target in screenshot space.
		for (let px = 0; px < ULTRAWIDE.width; px += 7) {
			const seen = toImagePoint(frame, { x: px, y: 0 })
			const clicked = toDisplayPoint(frame, seen)
			expect(Math.abs(clicked.x - px) / scaleX).toBeLessThanOrEqual(1)
		}
		for (let py = 0; py < ULTRAWIDE.height; py += 5) {
			const seen = toImagePoint(frame, { x: 0, y: py })
			const clicked = toDisplayPoint(frame, seen)
			expect(Math.abs(clicked.y - py) / scaleY).toBeLessThanOrEqual(1)
		}
		// The centre of the screenshot is the centre of the display.
		expect(toDisplayPoint(frame, { x: 784, y: 328 })).toEqual({ x: 1721, y: 721 })
	})

	it.each([
		[5120, 1440],
		[7680, 1080],
		[1080, 2400],
		[100, 5000],
		[2560, 1600],
		[1366, 768],
	])('keeps odd aspect ratio %ix%i on target', (width, height) => {
		const frame = frameOf({ ...ULTRAWIDE, width, height })
		const corners = [
			{ x: 0, y: 0 },
			{ x: frame.imageWidth - 1, y: frame.imageHeight - 1 },
			{ x: frame.imageWidth, y: frame.imageHeight },
		]
		for (const corner of corners) {
			const mapped = toDisplayPoint(frame, corner)
			expect(mapped.x).toBeGreaterThanOrEqual(0)
			expect(mapped.y).toBeGreaterThanOrEqual(0)
			expect(mapped.x).toBeLessThan(width)
			expect(mapped.y).toBeLessThan(height)
		}
		for (let x = 0; x < frame.imageWidth; x += 3)
			expect(toImagePoint(frame, toDisplayPoint(frame, { x, y: 0 })).x).toBe(x)
		for (let y = 0; y < frame.imageHeight; y += 3)
			expect(toImagePoint(frame, toDisplayPoint(frame, { x: 0, y })).y).toBe(y)
	})

	it('maps an unscaled screenshot one to one', () => {
		const frame = frameOf({ ...ULTRAWIDE, width: 1280, height: 800 })
		expect(toDisplayPoint(frame, { x: 17, y: 799 })).toEqual({ x: 17, y: 799 })
		expect(toImagePoint(frame, { x: 1279, y: 0 })).toEqual({ x: 1279, y: 0 })
	})

	it('stays display-relative on a high-DPI display left of the primary', () => {
		// A Retina-class panel at 200 %, placed left of the primary monitor.
		// Every number crossing the host boundary is already physical, so
		// neither the origin nor the scale factor enters the mapping.
		const hiDpi: DisplayInfo = {
			id: '2',
			x: -3840,
			y: 0,
			width: 3840,
			height: 2160,
			scaleFactor: 2,
		}
		const frame = frameOf(hiDpi)
		expect([frame.imageWidth, frame.imageHeight]).toEqual([1456, 819])
		const mapped = toDisplayPoint(frame, { x: 728, y: 409 })
		expect(mapped.x).toBeGreaterThanOrEqual(1918)
		expect(mapped.x).toBeLessThanOrEqual(1922)
		expect(mapped.y).toBeGreaterThanOrEqual(1078)
		expect(mapped.y).toBeLessThanOrEqual(1082)
	})

	it('admits the far edge and refuses anything beyond it', () => {
		const frame = frameOf(ULTRAWIDE)
		expect(pointOnImage(frame, { x: 1568, y: 656 })).toBe(true)
		expect(toDisplayPoint(frame, { x: 1568, y: 656 })).toEqual({ x: 3439, y: 1439 })
		expect(pointOnImage(frame, { x: 1569, y: 0 })).toBe(false)
		expect(pointOnImage(frame, { x: 0, y: -1 })).toBe(false)
		// A native-resolution coordinate, the failure this guards against.
		expect(pointOnImage(frame, { x: 2900, y: 1200 })).toBe(false)
	})
})

describe('rectangles', () => {
	it('covers an image region completely on the display, clamped', () => {
		const frame = frameOf(ULTRAWIDE)
		const rect = toDisplayRect(frame, { x: 100, y: 50, width: 200, height: 100 })
		expect(rect).not.toBeNull()
		expect(rect?.x).toBeLessThanOrEqual(Math.floor(100 * (3440 / 1568)))
		expect((rect?.x ?? 0) + (rect?.width ?? 0)).toBeGreaterThanOrEqual(
			Math.floor(300 * (3440 / 1568)),
		)
		expect(toDisplayRect(frame, { x: 1500, y: 600, width: 500, height: 500 })).toEqual({
			x: 3290,
			y: 1317,
			width: 150,
			height: 123,
		})
		expect(toDisplayRect(frame, { x: 1600, y: 0, width: 10, height: 10 })).toBeNull()
	})

	it('places virtual-desktop window bounds on the screenshot of their display', () => {
		const secondary: DisplayInfo = { ...ULTRAWIDE, id: '1', x: 3440 }
		const frame = frameOf(secondary)
		// Wholly on the primary display: not on this screenshot.
		expect(desktopRectOnImage(frame, { x: 100, y: 100, width: 800, height: 600 })).toBeNull()
		// Straddling both: only the visible part, in screenshot pixels.
		const straddling = desktopRectOnImage(frame, { x: 3000, y: 0, width: 1000, height: 720 })
		expect(straddling).toEqual({ x: 0, y: 0, width: 256, height: 328 })
	})
})

describe('ScreenshotFrames', () => {
	it('numbers frames, keeps the latest and forgets the oldest past capacity', () => {
		const frames = new ScreenshotFrames(2)
		expect(frames.latest()).toBeUndefined()
		const first = frames.record({ width: 10, height: 10 }, assumedDisplay(10, 10))
		const second = frames.record({ width: 20, height: 20 }, assumedDisplay(40, 40))
		const third = frames.record({ width: 30, height: 30 }, assumedDisplay(60, 60))
		expect([first.id, second.id, third.id]).toEqual(['s1', 's2', 's3'])
		expect(frames.latest()).toBe(third)
		expect(frames.get('s1')).toBeUndefined()
		expect(frames.get('s2')).toBe(second)
	})

	it('assumes a single unscaled display at the origin for a host that reports none', () => {
		expect(assumedDisplay(1920, 1080)).toEqual({
			id: 'default',
			x: 0,
			y: 0,
			width: 1920,
			height: 1080,
			scaleFactor: 1,
			primary: true,
		})
	})
})
