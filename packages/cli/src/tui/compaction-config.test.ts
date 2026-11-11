import { describe, expect, it } from 'vitest'
import { DEFAULT_SOFT_TARGET_HEADROOM, compactionConfigFor } from './agent.js'

/**
 * The terminal's compaction settings reach the kernel through one function,
 * for the interactive session, `exec`, the desktop host (`acp`), scheduled
 * runs, the manual and idle passes and sub-agents alike. The default headroom
 * lives there and nowhere else.
 */
describe("the terminal's compaction configuration", () => {
	it('asks for a headroom of 0.05 when none was set', () => {
		expect(DEFAULT_SOFT_TARGET_HEADROOM).toBe(0.05)
		expect(compactionConfigFor(undefined).softTargetHeadroom).toBe(0.05)
		expect(compactionConfigFor({}).softTargetHeadroom).toBe(0.05)
		expect(compactionConfigFor({ strategy: 'salience' }).softTargetHeadroom).toBe(0.05)
		expect(compactionConfigFor({ autoCompactWindowTokens: 50_000 }).softTargetHeadroom).toBe(0.05)
	})

	it('lets an explicit value win, zero included', () => {
		expect(compactionConfigFor({ softTargetHeadroom: 0.1 }).softTargetHeadroom).toBe(0.1)
		expect(compactionConfigFor({ softTargetHeadroom: 0 }).softTargetHeadroom).toBe(0)
		expect(compactionConfigFor({ softTargetHeadroom: 1 }).softTargetHeadroom).toBe(1)
	})

	it('gives a strategy other than salience no headroom from the default', () => {
		expect('softTargetHeadroom' in compactionConfigFor({ strategy: 'structured' })).toBe(false)
		// Said outright, it is passed on as written.
		expect(
			compactionConfigFor({ strategy: 'structured', softTargetHeadroom: 0.1 }).softTargetHeadroom,
		).toBe(0.1)
	})

	it('changes nothing else when a headroom is set', () => {
		const { softTargetHeadroom, ...rest } = compactionConfigFor({ softTargetHeadroom: 0.15 })
		expect(softTargetHeadroom).toBe(0.15)
		const { softTargetHeadroom: _d, ...base } = compactionConfigFor(undefined)
		expect(rest).toEqual(base)
	})
})
