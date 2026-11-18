import { describe, expect, it, vi } from 'vitest'

import { ARCHIVE_RETRY_MS, archiveAfterMs, archiveIdleConversations } from './archive-inactive.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-18T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

describe('archiving idle conversations', () => {
	it('maps the setting to a duration, and never to nothing', () => {
		expect(archiveAfterMs(undefined)).toBeUndefined()
		expect(archiveAfterMs('never')).toBeUndefined()
		expect(archiveAfterMs('1d')).toBe(DAY)
		expect(archiveAfterMs('7d')).toBe(7 * DAY)
		expect(archiveAfterMs('30d')).toBe(30 * DAY)
	})

	it('archives only the conversations idle long enough', async () => {
		const archive = vi.fn(async () => ({ archived: true }))
		const done = await archiveIdleConversations({
			candidates: [
				{ id: 'old', updatedAt: ago(2) },
				{ id: 'recent', updatedAt: ago(0.5) },
			],
			afterMs: DAY,
			now: NOW,
			archive,
		})
		expect(done).toEqual(['old'])
		expect(archive).toHaveBeenCalledTimes(1)
		expect(archive).toHaveBeenCalledWith('old')
	})

	it('does nothing when the setting is never', async () => {
		const archive = vi.fn(async () => ({ archived: true }))
		const done = await archiveIdleConversations({
			candidates: [{ id: 'old', updatedAt: ago(400) }],
			afterMs: undefined,
			now: NOW,
			archive,
		})
		expect(done).toEqual([])
		expect(archive).not.toHaveBeenCalled()
	})

	it('leaves a running conversation, or one with background work, for a later sweep', async () => {
		const archive = vi.fn(async (id: string) => {
			if (id === 'busy')
				throw new Error('Stop this conversation’s background work before archiving it.')
			return { archived: true }
		})
		const done = await archiveIdleConversations({
			candidates: [
				{ id: 'busy', updatedAt: ago(9) },
				{ id: 'idle', updatedAt: ago(9) },
			],
			afterMs: 7 * DAY,
			now: NOW,
			archive,
		})
		expect(done).toEqual(['idle'])
	})

	it('archives the longest idle first, however many rows there are, up to the cap', async () => {
		const archive = vi.fn(async () => ({ archived: true }))
		const candidates = Array.from({ length: 150 }, (_, i) => ({
			id: `c${i}`,
			updatedAt: ago(2 + i), // c0 newest ... c149 oldest
		}))
		const done = await archiveIdleConversations({
			candidates,
			afterMs: DAY,
			now: NOW,
			archive,
			limit: 3,
		})
		expect(done).toEqual(['c149', 'c148', 'c147'])
	})

	it('does not retry a refused conversation until the wait is over', async () => {
		const archive = vi.fn(async () => {
			throw new Error('busy')
		})
		const refused = new Map<string, number>()
		const run = (now: number) =>
			archiveIdleConversations({
				candidates: [{ id: 'busy', updatedAt: ago(9) }],
				afterMs: DAY,
				now,
				archive,
				refused,
			})
		await run(NOW)
		await run(NOW + 1000)
		expect(archive).toHaveBeenCalledTimes(1)
		await run(NOW + ARCHIVE_RETRY_MS + 1)
		expect(archive).toHaveBeenCalledTimes(2)
	})
})
