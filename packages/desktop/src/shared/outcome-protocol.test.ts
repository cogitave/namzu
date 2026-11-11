import { expect, it } from 'vitest'
import { OUTCOME_NOTIFICATION, readOutcomeNotice, readOutcomeSummary } from './outcome-protocol.js'

it('names the notification the host sends', () => {
	expect(OUTCOME_NOTIFICATION).toBe('namzu/session/outcome')
})

it('reads a notice and keeps only the known fields', () => {
	expect(
		readOutcomeNotice({
			sessionId: 's',
			turnId: 't',
			verdict: 'failing',
			line: 'Changed 2 files · npm test failed',
			changed: 2,
			outcome: { verdict: 'failing', checks: [] },
			extra: 'ignored',
		}),
	).toEqual({
		sessionId: 's',
		turnId: 't',
		verdict: 'failing',
		line: 'Changed 2 files · npm test failed',
		changed: 2,
	})
})

it('reads every verdict and refuses one it does not know', () => {
	for (const verdict of [
		'unchanged',
		'checked',
		'stale',
		'failing',
		'inconclusive',
		'unchecked',
		'unknown',
	])
		expect(readOutcomeSummary({ verdict, line: 'x', changed: 1 })?.verdict).toBe(verdict)
	expect(readOutcomeSummary({ verdict: 'great', line: 'x', changed: 1 })).toBeUndefined()
})

it('drops a line for an unchanged turn: there is nothing to say', () => {
	expect(readOutcomeSummary({ verdict: 'unchanged', line: 'Changed 1 file', changed: 0 })).toEqual({
		verdict: 'unchanged',
		changed: 0,
	})
})

it('turns control characters in the line into spaces and refuses a damaged frame', () => {
	expect(
		readOutcomeSummary({
			verdict: 'unchecked',
			line: 'Changed 1 file\u001b[2J · not checked',
			changed: 1,
		})?.line,
	).toBe('Changed 1 file [2J · not checked')
	expect(
		readOutcomeSummary({ verdict: 'unchecked', line: 'x'.repeat(501), changed: 1 })?.line,
	).toBeUndefined()
	expect(readOutcomeSummary({ verdict: 'unchecked', line: 'ok', changed: -3 })?.changed).toBe(0)
	expect(readOutcomeNotice({ verdict: 'checked', changed: 1 })).toBeUndefined()
	expect(readOutcomeNotice({ sessionId: 's', turnId: '', verdict: 'checked' })).toBeUndefined()
	expect(readOutcomeNotice(null)).toBeUndefined()
	expect(readOutcomeNotice([])).toBeUndefined()
})
