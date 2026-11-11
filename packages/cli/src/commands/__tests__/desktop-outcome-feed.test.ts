import type { SessionEvent, TurnOutcome } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import {
	OUTCOME_NOTIFICATION,
	announceOutcome,
	outcomeNotification,
	savedTurnOutcome,
} from '../desktop-outcome-feed.js'

const outcome = (over: Partial<TurnOutcome> = {}): TurnOutcome => ({
	verdict: 'unchecked',
	basis: 'calls',
	changes: { total: 2, paths: ['a.ts', 'b.ts'], outsideKnownTools: false },
	checks: [],
	...over,
})
const ended = (type: 'turn_completed' | 'turn_failed', record?: TurnOutcome): SessionEvent =>
	({
		type,
		sessionId: 's1',
		turnId: 't1',
		...(type === 'turn_failed' ? { error: 'x' } : { result: 'done' }),
		settlement: { status: 'completed', ...(record ? { outcome: record } : {}) },
	}) as unknown as SessionEvent

describe('the outcome notification', () => {
	it('is a namzu notification', () => {
		expect(OUTCOME_NOTIFICATION).toBe('namzu/session/outcome')
	})

	it('carries the turn, the verdict, the terminal wording, the count and the record', () => {
		const record = outcome()
		expect(outcomeNotification('s1', ended('turn_completed', record))).toEqual({
			sessionId: 's1',
			turnId: 't1',
			verdict: 'unchecked',
			line: 'Changed 2 files · not checked',
			changed: 2,
			outcome: record,
		})
	})

	it('keeps the full cannot-tell wording and the record for every turn, however often the terminal has said it', () => {
		const unknown = outcome({
			verdict: 'unknown',
			changes: { total: 0, paths: [], outsideKnownTools: false },
		})
		for (let i = 0; i < 3; i++) {
			expect(outcomeNotification('s1', ended('turn_completed', unknown))).toEqual({
				sessionId: 's1',
				turnId: 't1',
				verdict: 'unknown',
				line: 'A command ran that may have changed files · cannot tell',
				changed: 0,
				outcome: unknown,
			})
		}
	})

	it('uses the same words as the terminal for every verdict, including a check the pipe hides', () => {
		const masked = outcome({
			verdict: 'inconclusive',
			checks: [{ command: 'npm test | tail -5', step: 1, result: 'masked' }],
		})
		expect(outcomeNotification('s1', ended('turn_completed', masked))?.line).toBe(
			'Changed 2 files · ran npm test | tail -5, but the pipe hides whether it passed',
		)
		const failing = outcome({
			verdict: 'failing',
			checks: [{ command: 'npm test', step: 1, result: 'failed', exitCode: 1 }],
		})
		expect(outcomeNotification('s1', ended('turn_failed', failing))?.line).toBe(
			'Changed 2 files · npm test failed',
		)
		const checked = outcome({
			verdict: 'checked',
			checks: [{ command: 'npm test', step: 1, result: 'passed', exitCode: 0, fresh: true }],
		})
		expect(outcomeNotification('s1', ended('turn_completed', checked))?.line).toBe(
			'Changed 2 files · checked: npm test passed, nothing changed since',
		)
	})

	it('has no line for an unchanged turn, and none at all when the turn recorded nothing', () => {
		const unchanged = outcome({
			verdict: 'unchanged',
			changes: { total: 0, paths: [], outsideKnownTools: false },
		})
		const body = outcomeNotification('s1', ended('turn_completed', unchanged))
		expect(body?.verdict).toBe('unchanged')
		expect(body && 'line' in body).toBe(false)
		expect(outcomeNotification('s1', ended('turn_completed'))).toBeUndefined()
	})

	it('is sent only when a turn ends', () => {
		expect(
			outcomeNotification('s1', {
				type: 'turn_paused',
				sessionId: 's1',
			} as unknown as SessionEvent),
		).toBeUndefined()
		expect(
			outcomeNotification('s1', { type: 'token_usage_updated' } as unknown as SessionEvent),
		).toBeUndefined()
	})

	it('goes through notify once, and a closed stream does not fail the turn', () => {
		const notify = vi.fn()
		announceOutcome('s1', ended('turn_completed', outcome()), notify)
		expect(notify).toHaveBeenCalledTimes(1)
		expect(notify.mock.calls[0]?.[0]).toBe(OUTCOME_NOTIFICATION)
		announceOutcome('s1', { type: 'turn_paused' } as unknown as SessionEvent, notify)
		expect(notify).toHaveBeenCalledTimes(1)
		expect(() =>
			announceOutcome('s1', ended('turn_completed', outcome()), () => {
				throw new Error('closed')
			}),
		).not.toThrow()
	})
})

describe('a saved outcome', () => {
	it('keeps the verdict, the words and the count, nothing of the record', () => {
		expect(savedTurnOutcome(outcome())).toEqual({
			verdict: 'unchecked',
			line: 'Changed 2 files · not checked',
			changed: 2,
		})
	})
	it('reads a body that is not a record as no outcome', () => {
		expect(savedTurnOutcome({ verdict: 'checked' })).toBeUndefined()
		expect(savedTurnOutcome('x')).toBeUndefined()
		expect(savedTurnOutcome(undefined)).toBeUndefined()
	})
})
