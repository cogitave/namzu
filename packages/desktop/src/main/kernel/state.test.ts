import { describe, expect, it } from 'vitest'
import { readState } from './state.js'

describe('reading a state file', () => {
	it('never holds a version that is bad in a slot', () => {
		const state = readState({
			schema: 1,
			current: '51.3.0',
			previous: '51.2.0',
			pending: '51.4.0',
			bad: {
				'51.3.0': { reason: 'x', at: 1 },
				'51.2.0': { reason: 'y', at: 1 },
				'51.4.0': { reason: 'z', at: 1 },
			},
		})
		expect([state.current, state.previous, state.pending]).toEqual([
			undefined,
			undefined,
			undefined,
		])
	})

	it('keeps a good version in its slot', () => {
		const state = readState({ schema: 1, current: '51.3.0', previous: '51.2.0', bad: {} })
		expect([state.current, state.previous]).toEqual(['51.3.0', '51.2.0'])
	})
})
