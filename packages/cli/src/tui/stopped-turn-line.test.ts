import {
	AUTO_REVIEW_UNAVAILABLE_PREFIX,
	DECLINED_TOOL_CALL_FEEDBACK,
	type TurnOutcome,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { isCallNotRun, stoppedTurnLine } from './stopped-turn-line.js'

const outcome = (total: number): TurnOutcome => ({
	verdict: 'unchecked',
	basis: 'calls',
	changes: { total, paths: [], outsideKnownTools: false },
	checks: [],
})

describe('the line a stopped turn ends with', () => {
	it('says what was done and what is left', () => {
		expect(stoppedTurnLine({ outcome: outcome(6), notRun: 2 })).toBe(
			'Stopped before the task was finished · changed 6 files so far · 2 calls not run · send a message to carry on',
		)
	})

	it('reads in the singular, and when nothing changed and every call ran', () => {
		expect(stoppedTurnLine({ outcome: outcome(1), notRun: 1 })).toContain(
			'changed 1 file so far · 1 call not run',
		)
		expect(stoppedTurnLine({ outcome: undefined, notRun: 0 })).toBe(
			'Stopped before the task was finished · nothing was changed · the rest of the task is not done · send a message to carry on',
		)
	})
})

describe('which tool results are calls that did not run', () => {
	it('knows the auto mode holding a call back, and a person refusing it', () => {
		expect(
			isCallNotRun(
				`Error: Tool "bash" was not executed. ${AUTO_REVIEW_UNAVAILABLE_PREFIX}the safety check could not be completed (provider returned 400). Nothing was run.`,
			),
		).toBe(true)
		expect(
			isCallNotRun(`Error: Tool "bash" was not executed. ${DECLINED_TOOL_CALL_FEEDBACK}`),
		).toBe(true)
	})

	it('does not take a call that ran and failed for one', () => {
		expect(isCallNotRun('Exit code 1: tests failed')).toBe(false)
		expect(isCallNotRun(undefined)).toBe(false)
	})
})
