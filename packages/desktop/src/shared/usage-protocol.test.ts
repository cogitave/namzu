import { expect, it } from 'vitest'
import { USAGE_NOTIFICATION, readUsageNotice } from './usage-protocol.js'

it('names the notification the host sends', () => {
	expect(USAGE_NOTIFICATION).toBe('namzu/session/usage')
})

it('reads a full notice and keeps only the known fields', () => {
	expect(
		readUsageNotice({
			sessionId: 's',
			contextTokens: 10,
			contextWindowTokens: 100,
			contextMeasuredBy: 'estimate',
			cost: 0.25,
			compaction: 'finished',
			tokensBefore: 90,
			tokensAfter: 20,
			extra: 'ignored',
		}),
	).toEqual({
		sessionId: 's',
		contextTokens: 10,
		contextWindowTokens: 100,
		contextMeasuredBy: 'estimate',
		cost: 0.25,
		compaction: 'finished',
		tokensBefore: 90,
		tokensAfter: 20,
	})
})

it('drops a field that does not read and refuses a notice without a session', () => {
	expect(
		readUsageNotice({
			sessionId: 's',
			contextTokens: -1,
			contextWindowTokens: 0,
			cost: Number.NaN,
			compaction: 'later',
			contextMeasuredBy: 'guess',
		}),
	).toEqual({ sessionId: 's' })
	expect(readUsageNotice({ contextTokens: 1 })).toBeUndefined()
	expect(readUsageNotice({ sessionId: '' })).toBeUndefined()
	expect(readUsageNotice(null)).toBeUndefined()
	expect(readUsageNotice([])).toBeUndefined()
})
