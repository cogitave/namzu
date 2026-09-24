import { decode, encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import {
	HIGH_RES_SCREENSHOT_LIMITS,
	STANDARD_SCREENSHOT_LIMITS,
	type ScreenshotLimits,
	cropAndFitPng,
	fitPng,
	pngSize,
	screenshotTargetSize,
} from '../computer-use-image.js'

function fits(width: number, height: number, limits: ScreenshotLimits): boolean {
	return (
		Math.ceil(width / 28) * 28 <= limits.maxLongEdge &&
		Math.ceil(height / 28) * 28 <= limits.maxLongEdge &&
		Math.ceil(width / 28) * Math.ceil(height / 28) <= limits.maxTiles
	)
}

/** An RGB PNG whose four quadrants are red, green, blue and white. */
function quadrantPng(width: number, height: number, channels: 3 | 4 = 3): Buffer {
	const data = new Uint8Array(width * height * channels)
	for (let y = 0; y < height; y += 1) {
		for (let x = 0; x < width; x += 1) {
			const right = x >= width / 2
			const bottom = y >= height / 2
			const colour = !bottom
				? right
					? [0, 255, 0]
					: [255, 0, 0]
				: right
					? [255, 255, 255]
					: [0, 0, 255]
			const i = (y * width + x) * channels
			data.set(colour, i)
			if (channels === 4) data[i + 3] = 255
		}
	}
	return Buffer.from(encode({ width, height, data, channels, depth: 8 }))
}

describe('screenshotTargetSize', () => {
	it("reproduces the examples of Anthropic's published resize rule", () => {
		// "a 1920×1080 screenshot resizes to 1456×819, not 1568×882"
		expect(screenshotTargetSize(1920, 1080)).toEqual({ width: 1456, height: 819 })
		// The A4 scan whose edges fit but whose 2145 tokens do not.
		expect(screenshotTargetSize(1075, 1520)).toEqual({ width: 924, height: 1307 })
		// The high-resolution tier's 4K row.
		expect(screenshotTargetSize(3840, 2160, HIGH_RES_SCREENSHOT_LIMITS)).toEqual({
			width: 2576,
			height: 1449,
		})
		expect(screenshotTargetSize(1920, 1080, HIGH_RES_SCREENSHOT_LIMITS)).toEqual({
			width: 1920,
			height: 1080,
		})
	})

	it('leaves an image that already fits alone', () => {
		expect(screenshotTargetSize(800, 600)).toEqual({ width: 800, height: 600 })
		expect(screenshotTargetSize(1092, 1092)).toEqual({ width: 1092, height: 1092 })
		expect(screenshotTargetSize(1, 1)).toEqual({ width: 1, height: 1 })
	})

	it('fits the ultrawide 3440x1440 display that drifted in the field', () => {
		expect(screenshotTargetSize(3440, 1440)).toEqual({ width: 1568, height: 656 })
	})

	it.each([
		[3440, 1440],
		[5120, 1440],
		[7680, 1080],
		[1080, 2400],
		[100, 5000],
		[2560, 1600],
		[3456, 2234],
		[4000, 4000],
		[1568, 1014],
	])('returns the largest aspect-preserving size within both limits for %ix%i', (width, height) => {
		for (const limits of [STANDARD_SCREENSHOT_LIMITS, HIGH_RES_SCREENSHOT_LIMITS]) {
			const target = screenshotTargetSize(width, height, limits)
			expect(fits(target.width, target.height, limits)).toBe(true)
			expect(target.width).toBeLessThanOrEqual(width)
			expect(target.height).toBeLessThanOrEqual(height)
			// Aspect ratio survives to within one pixel of rounding.
			expect(Math.abs(target.width / target.height - width / height)).toBeLessThan(
				(width / height) * (1 / Math.min(target.width, target.height)) + 1e-9,
			)
			// One more pixel along the long edge no longer fits.
			if (target.width !== width || target.height !== height) {
				const long = Math.max(target.width, target.height) + 1
				const short = Math.max(
					Math.round((long * Math.min(width, height)) / Math.max(width, height)),
					1,
				)
				const [w, h] = width >= height ? [long, short] : [short, long]
				expect(fits(w, h, limits)).toBe(false)
			}
		}
	})

	it('transposes a portrait image exactly', () => {
		const landscape = screenshotTargetSize(3000, 2000)
		const portrait = screenshotTargetSize(2000, 3000)
		expect(portrait).toEqual({ width: landscape.height, height: landscape.width })
	})

	it('refuses sizes that are not positive integers', () => {
		expect(() => screenshotTargetSize(0, 10)).toThrow(RangeError)
		expect(() => screenshotTargetSize(10.5, 10)).toThrow(RangeError)
	})
})

describe('pngSize', () => {
	it('reads the IHDR without decoding', () => {
		expect(pngSize(quadrantPng(37, 11))).toEqual({ width: 37, height: 11 })
	})

	it('refuses bytes that are not a PNG', () => {
		expect(() => pngSize(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toThrow(/not a PNG/)
		expect(() => pngSize(Buffer.alloc(40))).toThrow(/not a PNG/)
	})
})

describe('fitPng', { timeout: 30_000 }, () => {
	it('returns a capture that already fits byte for byte', async () => {
		const small = quadrantPng(64, 48)
		const fitted = await fitPng(small, STANDARD_SCREENSHOT_LIMITS)
		expect(fitted.data).toBe(small)
		expect(fitted).toMatchObject({ width: 64, height: 48, sourceWidth: 64, sourceHeight: 48 })
	})

	it('shrinks a 3440x1440 capture to the size it reports, keeping what is where', async () => {
		const fitted = await fitPng(quadrantPng(3440, 1440, 4), STANDARD_SCREENSHOT_LIMITS)
		expect(fitted).toMatchObject({
			width: 1568,
			height: 656,
			sourceWidth: 3440,
			sourceHeight: 1440,
		})
		const decoded = decode(fitted.data)
		expect(decoded.width).toBe(1568)
		expect(decoded.height).toBe(656)
		// Opaque captures travel as RGB.
		expect(decoded.channels).toBe(3)
		const pixel = (x: number, y: number) => {
			const i = (y * decoded.width + x) * decoded.channels
			return [decoded.data[i], decoded.data[i + 1], decoded.data[i + 2]]
		}
		expect(pixel(100, 100)).toEqual([255, 0, 0])
		expect(pixel(1500, 100)).toEqual([0, 255, 0])
		expect(pixel(100, 600)).toEqual([0, 0, 255])
		expect(pixel(1500, 600)).toEqual([255, 255, 255])
	})

	it('reads grey, grey-alpha, 16-bit and palette captures', async () => {
		const grey = Buffer.from(
			encode({ width: 2000, height: 10, data: new Uint8Array(20_000).fill(128), channels: 1 }),
		)
		const greyAlpha = Buffer.from(
			encode({
				width: 2000,
				height: 10,
				data: new Uint8Array(40_000).map((_, i) => (i % 2 === 0 ? 64 : 200)),
				channels: 2,
			}),
		)
		const deep = Buffer.from(
			encode({
				width: 2000,
				height: 10,
				data: new Uint16Array(60_000).fill(0xff00),
				channels: 3,
				depth: 16,
			}),
		)
		const indexed = Buffer.from(
			encode({
				width: 2000,
				height: 10,
				data: new Uint8Array(20_000).fill(1),
				channels: 1,
				depth: 8,
				palette: [
					[0, 0, 0],
					[10, 20, 30],
				],
			}),
		)
		for (const [png, expected] of [
			[grey, [128, 128, 128]],
			[greyAlpha, [64, 64, 64]],
			[deep, [255, 255, 255]],
			[indexed, [10, 20, 30]],
		] as const) {
			const fitted = await fitPng(png, STANDARD_SCREENSHOT_LIMITS)
			expect(fitted.width).toBe(1568)
			const decoded = decode(fitted.data)
			expect([...decoded.data.slice(0, 3)]).toEqual(expected)
		}
		// Translucent pixels keep their alpha channel.
		expect(decode((await fitPng(greyAlpha, STANDARD_SCREENSHOT_LIMITS)).data).channels).toBe(4)
	})
})

describe('cropAndFitPng', { timeout: 30_000 }, () => {
	it('cuts exactly the requested pixels and does not enlarge them', async () => {
		const crop = await cropAndFitPng(
			quadrantPng(400, 200),
			{ x: 210, y: 110, width: 50, height: 40 },
			STANDARD_SCREENSHOT_LIMITS,
		)
		expect(crop).toMatchObject({ width: 50, height: 40, sourceWidth: 50, sourceHeight: 40 })
		const decoded = decode(crop.data)
		expect(new Set(decoded.data)).toEqual(new Set([255]))
	})

	it('fits a crop larger than the limits', async () => {
		const crop = await cropAndFitPng(
			quadrantPng(3440, 1440),
			{ x: 0, y: 0, width: 3440, height: 720 },
			STANDARD_SCREENSHOT_LIMITS,
		)
		expect(crop.width).toBeLessThanOrEqual(1568)
		expect(fits(crop.width, crop.height, STANDARD_SCREENSHOT_LIMITS)).toBe(true)
		expect(crop.sourceWidth).toBe(3440)
	})
})
