import { describe, expect, it } from 'vitest'

import { fullscreenFromEnv, resolveFullscreen } from './mode.js'

const world = { env: {}, interactive: true, hosted: false }

describe('whether the screen is fullscreen', () => {
	it('is off unless asked for', () => {
		expect(resolveFullscreen(world)).toBe(false)
	})

	it('follows the setting', () => {
		expect(resolveFullscreen({ ...world, setting: true })).toBe(true)
		expect(resolveFullscreen({ ...world, setting: false })).toBe(false)
	})

	it('lets the environment win over the setting, either way', () => {
		expect(resolveFullscreen({ ...world, env: { NAMZU_FULLSCREEN: '1' } })).toBe(true)
		expect(resolveFullscreen({ ...world, env: { NAMZU_FULLSCREEN: '0' }, setting: true })).toBe(
			false,
		)
		expect(resolveFullscreen({ ...world, env: { NAMZU_FULLSCREEN: 'true' }, setting: false })).toBe(
			true,
		)
	})

	it('reads an empty or negative value as off and an absent one as no answer', () => {
		expect(fullscreenFromEnv({ NAMZU_FULLSCREEN: '' })).toBe(false)
		expect(fullscreenFromEnv({ NAMZU_FULLSCREEN: 'off' })).toBe(false)
		expect(fullscreenFromEnv({})).toBeUndefined()
	})

	it('is never taken without a terminal or inside a workspaces host', () => {
		const on = { env: { NAMZU_FULLSCREEN: '1' }, setting: true }
		expect(resolveFullscreen({ ...on, interactive: false, hosted: false })).toBe(false)
		expect(resolveFullscreen({ ...on, interactive: true, hosted: true })).toBe(false)
	})
})
