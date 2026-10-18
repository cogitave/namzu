/**
 * Shift+Tab's cycle, as pure behaviour.
 *
 * The cycle is the reference's (`c4t`): default, accept edits, plan, then
 * bypass when the session may use it, then default again.
 */

import { describe, expect, it } from 'vitest'

import { bypassAvailableAtLaunch, nextCycleMode } from '../mode.js'

describe('nextCycleMode', () => {
	it('stops at plan unless bypass is available', () => {
		expect(nextCycleMode('prompt', false)).toBe('accept-edits')
		expect(nextCycleMode('accept-edits', false)).toBe('plan')
		expect(nextCycleMode('plan', false)).toBe('prompt')
		expect(nextCycleMode('plan', true)).toBe('auto')
	})

	it('leaves auto and strict for prompt, whatever bypass allows', () => {
		for (const available of [false, true]) {
			expect(nextCycleMode('auto', available)).toBe('prompt')
			expect(nextCycleMode('strict', available)).toBe('prompt')
		}
	})
})

describe('bypassAvailableAtLaunch', () => {
	it('is the launch mode auto, or the explicit flag', () => {
		expect(bypassAvailableAtLaunch({ launchMode: 'prompt' })).toBe(false)
		expect(bypassAvailableAtLaunch({ launchMode: 'plan' })).toBe(false)
		expect(bypassAvailableAtLaunch({ launchMode: 'auto' })).toBe(true)
		expect(
			bypassAvailableAtLaunch({ launchMode: 'prompt', allowDangerouslySkipPermissions: true }),
		).toBe(true)
	})
})
