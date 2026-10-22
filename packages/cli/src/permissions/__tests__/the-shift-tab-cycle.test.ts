/**
 * Shift+Tab's cycle, as pure behaviour.
 *
 * The cycle is the reference's: default, accept edits, plan, then bypass and
 * auto when the session may use them, then default again. `strict` is never on
 * it, and leaving it goes to default.
 */

import { describe, expect, it } from 'vitest'

import { autoAvailable, bypassAvailable, nextCycleMode } from '../mode.js'

const NEITHER = { bypass: false, auto: false } as const
const BYPASS = { bypass: true, auto: false } as const
const AUTO = { bypass: false, auto: true } as const
const BOTH = { bypass: true, auto: true } as const

describe('nextCycleMode', () => {
	it('stops at plan when neither bypass nor auto can be reached', () => {
		expect(nextCycleMode('prompt', NEITHER)).toBe('accept-edits')
		expect(nextCycleMode('accept-edits', NEITHER)).toBe('plan')
		expect(nextCycleMode('plan', NEITHER)).toBe('prompt')
	})

	it('walks prompt, accept-edits, plan, bypass, auto, prompt when both are open', () => {
		const walk = ['prompt']
		for (let i = 0; i < 5; i++) {
			walk.push(nextCycleMode(walk.at(-1) as never, BOTH))
		}
		expect(walk).toEqual(['prompt', 'accept-edits', 'plan', 'bypass', 'classify', 'prompt'])
	})

	it('skips the door that is shut', () => {
		expect(nextCycleMode('plan', BYPASS)).toBe('bypass')
		expect(nextCycleMode('bypass', BYPASS)).toBe('prompt')
		expect(nextCycleMode('plan', AUTO)).toBe('classify')
	})

	it('leaves strict and the unattended default for prompt, whatever is open', () => {
		for (const available of [NEITHER, BYPASS, AUTO, BOTH]) {
			expect(nextCycleMode('strict', available)).toBe('prompt')
			expect(nextCycleMode('auto', available)).toBe('prompt')
			expect(nextCycleMode('classify', available)).toBe('prompt')
		}
	})
})

describe('bypassAvailable', () => {
	it('opens for a flag that names it or the operator’s own default, and for nothing else', () => {
		expect(bypassAvailable({ flagged: false })).toBe(false)
		expect(bypassAvailable({ flagged: true })).toBe(true)
		expect(bypassAvailable({ flagged: false, defaultMode: 'bypass' })).toBe(true)
		expect(bypassAvailable({ flagged: false, defaultMode: 'auto' })).toBe(false)
		expect(bypassAvailable({ flagged: false, defaultMode: 'plan' })).toBe(false)
	})

	it('is shut by permissions.disableBypassMode whatever else says', () => {
		expect(bypassAvailable({ flagged: true, defaultMode: 'bypass', disabled: true })).toBe(false)
	})
})

describe('autoAvailable', () => {
	it('needs a model to ask and is not switched off', () => {
		expect(autoAvailable({ classifierUsable: true })).toBe(true)
		expect(autoAvailable({ classifierUsable: false })).toBe(false)
		expect(autoAvailable({ classifierUsable: true, disabled: true })).toBe(false)
	})
})
