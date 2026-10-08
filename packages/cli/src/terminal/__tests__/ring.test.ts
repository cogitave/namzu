import { describe, expect, it } from 'vitest'
import { OutputRing } from '../ring.js'

describe('OutputRing', () => {
	it('addresses output by absolute offset', () => {
		const ring = new OutputRing(100)
		ring.append('hello ')
		ring.append('world')
		expect(ring.start).toBe(0)
		expect(ring.end).toBe(11)
		expect(ring.slice(0)).toBe('hello world')
		expect(ring.slice(6)).toBe('world')
		expect(ring.slice(11)).toBe('')
	})

	it('drops the oldest output and keeps offsets absolute', () => {
		const ring = new OutputRing(8)
		ring.append('abcd')
		ring.append('efgh')
		ring.append('ijkl')
		expect(ring.end).toBe(12)
		expect(ring.start).toBe(4)
		expect(ring.slice(4)).toBe('efghijkl')
		expect(ring.slice(3)).toBeNull()
	})

	it('trims inside a chunk when one append exceeds the capacity', () => {
		const ring = new OutputRing(4)
		ring.append('0123456789')
		expect(ring.start).toBe(6)
		expect(ring.slice(6)).toBe('6789')
		expect(ring.slice(5)).toBeNull()
	})

	it('refuses an offset ahead of the end', () => {
		const ring = new OutputRing(10)
		ring.append('abc')
		expect(ring.slice(4)).toBeNull()
	})

	it('never starts on the second half of a surrogate pair', () => {
		const ring = new OutputRing(2)
		ring.append('a😀b')
		expect(ring.end).toBe(4)
		// A cut at 2 would leave the pair's second half first; the ring moves past it.
		expect(ring.start).toBe(3)
		expect(ring.slice(3)).toBe('b')
	})

	it('rejects a capacity that cannot hold anything', () => {
		expect(() => new OutputRing(0)).toThrow(RangeError)
	})
})
