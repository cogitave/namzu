import { describe, expect, it, vi } from 'vitest'
import { computerFramePresented } from './computer-frame-presented.js'

const geometry = { width: 8, height: 6 }
const points = [
	[4, 3],
	[0, 0],
	[7, 0],
	[0, 5],
	[7, 5],
] as const

function canvas(alpha: (x: number, y: number) => number, rgb = 0) {
	const getImageData = vi.fn((x: number, y: number, width: number, height: number): ImageData => {
		expect([width, height]).toEqual([1, 1])
		return {
			width: 1,
			height: 1,
			colorSpace: 'srgb',
			data: new Uint8ClampedArray([rgb, rgb, rgb, alpha(x, y)]),
		}
	})
	const getContext = vi.fn((_kind: '2d') => ({ getImageData }))
	return { ...geometry, getContext, getImageData }
}

describe('presented computer framebuffer', () => {
	it('does not mistake connected geometry or nonzero RGB for a presented frame', () => {
		const empty = canvas(() => 0, 255)
		expect(computerFramePresented(empty, geometry)).toBe(false)
	})

	it('accepts a fully opaque pure-black guest and reads only five individual pixels', () => {
		const black = canvas(() => 255)
		expect(computerFramePresented(black, geometry)).toBe(true)
		expect(black.getImageData.mock.calls.map(([x, y]) => [x, y])).toEqual(points)
	})

	it.each(points)(
		'keeps a partial frame unready when (%s,%s) is transparent',
		(missingX, missingY) => {
			const partial = canvas((x, y) => (x === missingX && y === missingY ? 0 : 255))
			expect(computerFramePresented(partial, geometry)).toBe(false)
		},
	)

	it('waits for opacity, not a translucent initialization pixel', () => {
		expect(
			computerFramePresented(
				canvas(() => 254),
				geometry,
			),
		).toBe(false)
	})

	it.each([
		{ width: 0, height: 6 },
		{ width: 8, height: 0 },
		{ width: 8.5, height: 6 },
		{ width: Number.NaN, height: 6 },
		{ width: 7, height: 6 },
	])('refuses invalid or mismatched expected geometry without reading pixels: %j', (expected) => {
		const black = canvas(() => 255)
		expect(computerFramePresented(black, expected)).toBe(false)
		expect(black.getContext).not.toHaveBeenCalled()
	})

	it('does not reuse paint readiness for a fresh same-size connection canvas', () => {
		expect(
			computerFramePresented(
				canvas(() => 255),
				geometry,
			),
		).toBe(true)
		expect(
			computerFramePresented(
				canvas(() => 0),
				geometry,
			),
		).toBe(false)
	})

	it('keeps missing or failed Canvas2D access unready', () => {
		expect(computerFramePresented({ ...geometry, getContext: () => null }, geometry)).toBe(false)
		expect(
			computerFramePresented(
				{
					...geometry,
					getContext: () => {
						throw new Error('Unavailable canvas')
					},
				},
				geometry,
			),
		).toBe(false)
		const unreadable = canvas(() => 255)
		unreadable.getImageData.mockImplementation(() => {
			throw new Error('Canvas read refused')
		})
		expect(computerFramePresented(unreadable, geometry)).toBe(false)
	})
})
