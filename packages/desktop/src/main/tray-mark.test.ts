import { describe, expect, it } from 'vitest'
import { paintTestMark } from './tray-mark.js'

describe('the test profile tray mark', () => {
	it('colours the lower-right corner and leaves the upper-left alone', () => {
		const size = 24
		const bitmap = Buffer.alloc(size * size * 4, 0)
		const marked = paintTestMark(bitmap, size)
		const px = (x: number, y: number) => [
			...marked.subarray((y * size + x) * 4, (y * size + x) * 4 + 4),
		]
		expect(px(0, 0)).toEqual([0, 0, 0, 0])
		expect(px(size - 8, size - 8)).toEqual([0, 140, 255, 255])
		expect([...bitmap.subarray(0, 4)]).toEqual([0, 0, 0, 0])
	})
})
