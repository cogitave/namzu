import { describe, expect, it } from 'vitest'
import * as sdk from '../../index.js'

describe('public schedule surface', () => {
	it('exports the time engine, the evaluator and the tool builders', () => {
		for (const name of [
			'parseScheduleSpec',
			'parseCronExpression',
			'nextFireTime',
			'previousFireTime',
			'countOccurrences',
			'upcomingFireTimes',
			'describeSchedule',
			'validateTimeZone',
			'hostTimeZone',
			'parseDuration',
			'evaluateJob',
			'buildScheduleTools',
			'buildSessionLoopTools',
			'scanSchedulePrompt',
			'revealHiddenCharacters',
			'generateScheduleJobId',
			'generateScheduleRunId',
		]) {
			expect(typeof (sdk as Record<string, unknown>)[name], name).toBe('function')
		}
		expect(sdk.SCHEDULE_TOOL_NAME).toBe('schedule')
		expect(sdk.SESSION_LOOP_TOOL_NAME).toBe('session_loop')
		expect(sdk.SCHEDULE_CATCH_UP_WINDOW_MS).toBe(604_800_000)
		expect(sdk.SCHEDULE_LATE_GRACE_MS).toBe(120_000)
		expect(new sdk.ScheduleValidationError('x', 'y').token).toBe('y')
		expect(sdk.generateScheduleJobId()).toMatch(/^[0-9a-f-]{36}$/)
	})
})
