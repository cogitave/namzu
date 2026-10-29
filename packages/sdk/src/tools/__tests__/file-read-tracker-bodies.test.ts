import { describe, expect, it } from 'vitest'

import { createFileReadTracker } from '../file-read-tracker.js'

describe('the observation ledger keeps the body of a file it saw whole', () => {
	it('keeps a full read, a full write and an edit result, in the order they were seen', () => {
		const tracker = createFileReadTracker()
		tracker.recordFullRead?.('/w/a', 'read body', 'c1', 'r')
		tracker.recordRead('/w/b', 'written body', 'c2')
		tracker.recordEdit?.('/w/b', 'edited body', 'c3')
		expect(tracker.fullBody?.('/w/a')).toBe('read body')
		expect(tracker.fullBody?.('/w/b')).toBe('edited body')
		expect(tracker.fullBodyPaths?.()).toEqual(['/w/a', '/w/b'])
	})

	it('drops the body once the file is seen through a window or not at all', () => {
		const tracker = createFileReadTracker()
		tracker.recordFullRead?.('/w/a', 'whole', 'c1', 'r')
		tracker.recordRead('/w/a', 'whole')
		expect(tracker.fullBody?.('/w/a')).toBeUndefined()
		expect(tracker.hasRead('/w/a')).toBe(true)
	})

	it('moves the body and the fingerprint together when the host records a new whole body', () => {
		const tracker = createFileReadTracker()
		tracker.recordFullRead?.('/w/a', 'old', 'c1', 'r')
		const before = tracker.fingerprint?.('/w/a')
		tracker.recordFullBody?.('/w/a', 'new')
		expect(tracker.fullBody?.('/w/a')).toBe('new')
		expect(tracker.fingerprint?.('/w/a')).not.toBe(before)
		expect(tracker.readWitness?.('/w/a')).toBeUndefined()
	})

	it('keeps no body for a very large file, and forgets the oldest of many', () => {
		const tracker = createFileReadTracker()
		tracker.recordFullRead?.('/w/huge', 'x'.repeat(600 * 1024), 'c1', 'r')
		expect(tracker.fullBody?.('/w/huge')).toBeUndefined()
		expect(tracker.hasRead('/w/huge')).toBe(true)
		for (let i = 0; i < 130; i++) tracker.recordFullRead?.(`/w/f${i}`, `body ${i}`, `c${i}`, 'r')
		expect(tracker.fullBody?.('/w/f0')).toBeUndefined()
		expect(tracker.fullBody?.('/w/f129')).toBe('body 129')
		expect(tracker.fullBodyPaths?.()).toHaveLength(128)
	})
})
