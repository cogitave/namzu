import { describe, expect, it } from 'vitest'
import { compactionConfigFor } from './agent.js'

/**
 * The terminal's compaction settings reach the kernel through one function.
 * A headroom is passed on only when it was set, so a terminal that never
 * set it hands the kernel exactly the object it always did.
 */
describe("the terminal's compaction configuration", () => {
	it('has no headroom unless one was set, so the kernel keeps its own default', () => {
		const config = compactionConfigFor(undefined)
		expect('softTargetHeadroom' in config).toBe(false)
		expect(compactionConfigFor({})).toEqual(config)
		expect(compactionConfigFor({ strategy: 'salience' })).toEqual(config)
	})

	it('passes a headroom through, zero included', () => {
		expect(compactionConfigFor({ softTargetHeadroom: 0.1 }).softTargetHeadroom).toBe(0.1)
		expect(compactionConfigFor({ softTargetHeadroom: 0 }).softTargetHeadroom).toBe(0)
	})

	it('changes nothing else when a headroom is set', () => {
		const { softTargetHeadroom, ...rest } = compactionConfigFor({ softTargetHeadroom: 0.15 })
		expect(softTargetHeadroom).toBe(0.15)
		expect(rest).toEqual(compactionConfigFor(undefined))
	})
})
