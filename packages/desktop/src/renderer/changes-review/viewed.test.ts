import { describe, expect, it } from 'vitest'
import { fingerprintOf, hashText, viewedState } from './viewed.js'

describe('marks as viewed', () => {
	it('hashes the same text the same and different text differently', () => {
		expect(hashText('a\nb')).toBe(hashText('a\nb'))
		expect(hashText('a\nb')).not.toBe(hashText('a\nc'))
	})

	it('is unviewed without a mark and viewed while nothing changed', () => {
		const now = fingerprintOf({ added: 2, removed: 1 }, 'x')
		expect(viewedState(undefined, now)).toBe('unviewed')
		expect(viewedState(now, now)).toBe('viewed')
	})

	it('goes stale when the counts move', () => {
		const mark = fingerprintOf({ added: 2, removed: 1 }, 'x')
		expect(viewedState(mark, fingerprintOf({ added: 3, removed: 1 }, 'x'))).toBe('stale')
	})

	it('goes stale when the text changes under the same counts, once both sides know their text', () => {
		const mark = fingerprintOf({ added: 1, removed: 1 }, 'one')
		expect(viewedState(mark, fingerprintOf({ added: 1, removed: 1 }, 'two'))).toBe('stale')
	})

	it('stays viewed when only one side has loaded its text', () => {
		const counts = fingerprintOf({ added: 1, removed: 1 })
		expect(viewedState(counts, fingerprintOf({ added: 1, removed: 1 }, 'two'))).toBe('viewed')
		expect(viewedState(fingerprintOf({ added: 1, removed: 1 }, 'two'), counts)).toBe('viewed')
	})
})
