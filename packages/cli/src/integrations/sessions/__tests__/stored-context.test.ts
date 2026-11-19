import type { Message, SessionRecord } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { lastStoredModel, lastTurnStatus, storedContext } from '../stored-context.js'

const rec = (value: Record<string, unknown>) => value as unknown as SessionRecord
const usage = (over: Record<string, unknown> = {}) =>
	rec({
		type: 'token_usage_updated',
		contextTokens: 20_000,
		contextWindowTokens: 200_000,
		contextMeasuredBy: 'provider',
		windowSource: 'model-table',
		...over,
	})
const turnStarted = (model = 'claude-sonnet-4') =>
	rec({ type: 'turn_started', turnId: 't1', config: { model } })
const completed = (status: 'completed' | 'cancelled' = 'completed') =>
	rec({ type: 'turn_completed', turnId: 't1', settlement: { status } })
const messages = (text: string): Message[] => [{ role: 'user', content: text }]

describe('the context a log remembers', () => {
	it('reads the last count the provider gave, and says it came from the log', () => {
		const got = storedContext(
			[turnStarted(), usage({ contextTokens: 10_000 }), usage({ contextTokens: 30_000 })],
			messages('hi'),
		)
		expect(got).toEqual({
			tokens: 30_000,
			windowTokens: 200_000,
			measuredBy: 'provider',
			windowSource: 'model-table',
			fromRecord: true,
		})
	})

	it('takes the size after a shortening as an estimate, out of date until the next count', () => {
		const got = storedContext(
			[
				usage(),
				rec({ type: 'compaction_completed', tokensAfter: 5_000, contextWindowTokens: 200_000 }),
			],
			[],
		)
		expect(got).toMatchObject({
			tokens: 5_000,
			measuredBy: 'estimate',
			sizeOutOfDate: true,
			fromRecord: true,
		})
	})

	it('estimates from the stored messages only where the model window is known', () => {
		const text = 'x'.repeat(4_000)
		const known = storedContext([turnStarted('claude-sonnet-4')], messages(text))
		expect(known).toMatchObject({ measuredBy: 'estimate', fromRecord: false })
		expect(known?.windowTokens).toBeGreaterThan(0)
		expect(known?.tokens).toBeGreaterThan(0)
		expect(known?.tokens).toBeLessThan(known?.windowTokens ?? 0)
		// A model the table does not know, and a log that names no model, stay uncounted.
		expect(storedContext([turnStarted('no-such-model-xyz')], messages(text))).toBeNull()
		expect(storedContext([], messages(text))).toBeNull()
	})

	it('has nothing for a conversation without a record or a message', () => {
		expect(storedContext([turnStarted()], [])).toBeNull()
	})

	it('names the model of the last turn that started', () => {
		expect(lastStoredModel([turnStarted('a'), turnStarted('b')])).toBe('b')
		expect(lastStoredModel([])).toBeUndefined()
	})
})

describe('how the last turn ended', () => {
	it('reads each ending from the log', () => {
		expect(lastTurnStatus([])).toBeUndefined()
		expect(lastTurnStatus([turnStarted(), completed()])).toBe('completed')
		expect(lastTurnStatus([turnStarted(), completed('cancelled')])).toBe('cancelled')
		expect(
			lastTurnStatus([turnStarted(), rec({ type: 'turn_failed', turnId: 't1', error: 'x' })]),
		).toBe('failed')
		expect(
			lastTurnStatus([turnStarted(), rec({ type: 'turn_paused', turnId: 't1', reason: 'r' })]),
		).toBe('paused')
	})

	it('calls a log that stops inside a turn interrupted, the mark a crash leaves', () => {
		expect(lastTurnStatus([turnStarted(), completed(), turnStarted()])).toBe('interrupted')
		expect(
			lastTurnStatus([
				turnStarted(),
				rec({ type: 'turn_paused', turnId: 't1' }),
				rec({ type: 'turn_resuming', turnId: 't1' }),
			]),
		).toBe('interrupted')
	})

	it('judges only the last turn', () => {
		expect(
			lastTurnStatus([
				turnStarted(),
				rec({ type: 'turn_failed', turnId: 't1', error: 'x' }),
				turnStarted(),
				completed(),
			]),
		).toBe('completed')
	})
})
