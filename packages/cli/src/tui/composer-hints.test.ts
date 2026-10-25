import { describe, expect, it } from 'vitest'

import { QUEUED_HINT_LIMIT, nextQueuedHintEpisode } from './composer-hints.js'

describe('nextQueuedHintEpisode', () => {
	it('decides on the transition itself, so the first frame already has the answer', () => {
		const idle = { active: false, show: false, count: 0 }
		expect(nextQueuedHintEpisode(idle, true)).toEqual({ active: true, show: true, count: 1 })
	})

	it('counts one appearance once however often it is asked', () => {
		const first = nextQueuedHintEpisode({ active: false, show: false, count: 0 }, true)
		expect(nextQueuedHintEpisode(first, true)).toBe(first)
	})

	it('stops showing once the limit is reached and does not count the plain placeholder', () => {
		let episode = { active: false, show: false, count: QUEUED_HINT_LIMIT }
		episode = nextQueuedHintEpisode(episode, true)
		expect(episode).toEqual({ active: true, show: false, count: QUEUED_HINT_LIMIT })
		expect(nextQueuedHintEpisode(episode, false).count).toBe(QUEUED_HINT_LIMIT)
	})
})
