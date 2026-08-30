import { describe, expect, it } from 'vitest'

import { BoundedTailCapture } from './output.js'

function bytes(text: string): Buffer {
	return Buffer.from(text, 'utf8')
}

describe('BoundedTailCapture', () => {
	it('keeps an exact-cap stream whole and unflagged', () => {
		const capture = new BoundedTailCapture(4)

		capture.push(bytes('abcd'))

		expect(capture.text).toBe('abcd')
		expect(capture.truncated).toBe(false)
		expect(capture.retainedBytes).toBe(4)
		expect(capture.allocatedBytes).toBeLessThanOrEqual(4)
	})

	it('copies only the newest bytes from one oversized input', () => {
		const capture = new BoundedTailCapture(5)

		capture.push(bytes('0123456789'))

		expect(capture.text).toBe('56789')
		expect(capture.truncated).toBe(true)
		expect(capture.retainedBytes).toBe(5)
		expect(capture.allocatedBytes).toBeLessThanOrEqual(5)
	})

	it('never grows retained or backing bytes past the cap across mixed chunks', () => {
		const cap = 17
		const capture = new BoundedTailCapture(cap)
		let complete = Buffer.alloc(0)
		const chunks = ['a', 'bcdef', '012345678901234567890', '✓', 'tail', '', 'xyz']

		for (const chunk of chunks) {
			const next = bytes(chunk)
			capture.push(next)
			complete = Buffer.concat([complete, next])

			expect(capture.retainedBytes).toBeLessThanOrEqual(cap)
			expect(capture.allocatedBytes).toBeLessThanOrEqual(cap)
			expect(Buffer.byteLength(capture.text, 'utf8')).toBeLessThanOrEqual(cap)
		}

		expect(capture.bytes).toEqual(complete.subarray(-cap))
		expect(capture.truncated).toBe(complete.length > cap)
	})

	it('decodes a code point split across ordinary stream chunks only after close', () => {
		const capture = new BoundedTailCapture(16)
		const value = bytes('A€B')

		capture.push(value.subarray(0, 2))
		capture.push(value.subarray(2))

		expect(capture.text).toBe('A€B')
		expect(capture.text).not.toContain('\uFFFD')
		expect(capture.truncated).toBe(false)
	})

	it('drops only the partial leading code point introduced by tail eviction', () => {
		const capture = new BoundedTailCapture(5)

		capture.push(bytes('A€TAIL'))

		expect(capture.bytes).toEqual(bytes('€TAIL').subarray(-5))
		expect(capture.text).toBe('TAIL')
		expect(capture.text).not.toContain('\uFFFD')
		expect(capture.truncated).toBe(true)
	})
})
