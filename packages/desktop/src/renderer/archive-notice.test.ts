import { describe, expect, it } from 'vitest'
import { addToArchiveBatch, archiveNoticeText, removeFromArchiveBatch } from './archive-notice.js'

describe('archive notice batches', () => {
	it('starts a batch with one conversation', () => {
		expect(addToArchiveBatch(undefined, 'a', 1000, 20_000)).toEqual({ ids: ['a'], until: 21_000 })
	})
	it('merges a later archive into the live batch and restarts its clock', () => {
		const first = addToArchiveBatch(undefined, 'a', 1000, 20_000)
		const second = addToArchiveBatch(first, 'b', 5000, 20_000)
		expect(second).toEqual({ ids: ['a', 'b'], until: 25_000 })
	})
	it('starts again once the earlier notice is gone', () => {
		const first = addToArchiveBatch(undefined, 'a', 1000, 20_000)
		expect(addToArchiveBatch(first, 'b', 21_000, 20_000).ids).toEqual(['b'])
	})
	it('counts a conversation once', () => {
		const first = addToArchiveBatch(undefined, 'a', 0, 10)
		expect(addToArchiveBatch(first, 'a', 1, 10).ids).toEqual(['a'])
	})
	it('says how many were archived', () => {
		expect(archiveNoticeText(1)).toContain('Conversation archived')
		expect(archiveNoticeText(3)).toMatch(/^3 conversations archived/)
	})
	it('points at the archive button next to Recents, in plain words', () => {
		expect(archiveNoticeText(1)).toBe(
			'Conversation archived. Find it with the archive button next to Recents.',
		)
		expect(archiveNoticeText(2)).toContain('Find them with the archive button next to Recents.')
	})
	it('drops a restored conversation from the batch and keeps the clock', () => {
		const batch = addToArchiveBatch(addToArchiveBatch(undefined, 'a', 0, 100), 'b', 10, 100)
		expect(removeFromArchiveBatch(batch, 'a', 20)).toEqual({ ids: ['b'], until: 110 })
	})
	it('has no batch once every conversation in it was restored', () => {
		const batch = addToArchiveBatch(undefined, 'a', 0, 100)
		expect(removeFromArchiveBatch(batch, 'a', 5)).toBeUndefined()
	})
	it('leaves the batch alone when a conversation outside it is restored', () => {
		const batch = addToArchiveBatch(undefined, 'a', 0, 100)
		expect(removeFromArchiveBatch(batch, 'z', 5)).toEqual(batch)
	})
	it('has no batch once its notice is gone', () => {
		const batch = addToArchiveBatch(undefined, 'a', 0, 100)
		expect(removeFromArchiveBatch(batch, 'b', 100)).toBeUndefined()
		expect(removeFromArchiveBatch(undefined, 'a', 0)).toBeUndefined()
	})
	it('does not carry restored conversations into the next count', () => {
		const restored = removeFromArchiveBatch(addToArchiveBatch(undefined, 'a', 0, 100), 'a', 5)
		expect(addToArchiveBatch(restored, 'a', 10, 100).ids).toEqual(['a'])
	})
})
