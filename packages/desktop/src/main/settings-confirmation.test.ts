import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_DESKTOP_SETTINGS, type DesktopSettings } from '../shared/settings-protocol.js'
import { FolderAccessTokens } from './folder-access.js'
import { SettingsConfirmation } from './settings-confirmation.js'

function setup() {
	let now = 1_000
	let current: DesktopSettings = { ...DEFAULT_DESKTOP_SETTINGS }
	const set = vi.fn((patch: Partial<DesktopSettings>) => {
		current = { ...current, ...patch }
		return current
	})
	let counter = 0
	const tokens = new FolderAccessTokens(
		() => now,
		() => `t${++counter}`,
	)
	const confirmation = new SettingsConfirmation({ get: () => current, set, tokens })
	return {
		confirmation,
		set,
		tokens,
		advance: (ms: number) => {
			now += ms
		},
		get: () => current,
	}
}

const off = { retrustOnConfigChange: false }

describe('SettingsConfirmation', () => {
	it('asks for confirmation instead of turning the check off, and changes nothing', () => {
		const s = setup()
		const result = s.confirmation.change('w1', off)
		expect(result).toEqual({
			status: 'confirm',
			settings: DEFAULT_DESKTOP_SETTINGS,
			token: 't1',
		})
		expect(s.set).not.toHaveBeenCalled()
		expect(s.get().retrustOnConfigChange).toBe(true)
	})

	it('applies the change with a valid token, once', () => {
		const s = setup()
		const first = s.confirmation.change('w1', off)
		if (first.status !== 'confirm') throw new Error('expected a confirmation')
		expect(s.confirmation.change('w1', off, first.token)).toMatchObject({
			status: 'saved',
			settings: { retrustOnConfigChange: false },
		})
		// Back on, then off again: the spent token buys nothing.
		s.confirmation.change('w1', { retrustOnConfigChange: true })
		expect(() => s.confirmation.change('w1', off, first.token)).toThrow('expired')
		expect(s.get().retrustOnConfigChange).toBe(true)
	})

	it('refuses an unknown, expired, foreign-window or different-change token', () => {
		const s = setup()
		const issue = () => {
			const r = s.confirmation.change('w1', off)
			if (r.status !== 'confirm') throw new Error('expected a confirmation')
			return r.token
		}
		expect(() => s.confirmation.change('w1', off, 'nope')).toThrow('expired')
		const expiring = issue()
		s.advance(5 * 60_000 + 1)
		expect(() => s.confirmation.change('w1', off, expiring)).toThrow('expired')
		expect(() => s.confirmation.change('w2', off, issue())).toThrow('expired')
		expect(() => s.confirmation.change('w1', { ...off, startup: 'home' }, issue())).toThrow(
			'expired',
		)
		expect(() => s.confirmation.change('w1', off, 7)).toThrow('Invalid confirmation')
		expect(s.set).not.toHaveBeenCalled()
		expect(s.get().retrustOnConfigChange).toBe(true)
	})

	it('binds a token to the same keys and values in any order', () => {
		const s = setup()
		const r = s.confirmation.change('w1', { retrustOnConfigChange: false, startup: 'home' })
		if (r.status !== 'confirm') throw new Error('expected a confirmation')
		expect(
			s.confirmation.change('w1', { startup: 'home', retrustOnConfigChange: false }, r.token),
		).toMatchObject({ status: 'saved' })
	})

	it('never needs a token to turn it on or to change anything else', () => {
		const s = setup()
		expect(s.confirmation.change('w1', { startup: 'home' }).status).toBe('saved')
		s.confirmation.change('w1', off, (s.confirmation.change('w1', off) as { token: string }).token)
		expect(s.confirmation.change('w1', { retrustOnConfigChange: true }).status).toBe('saved')
		// Already on -> off is the only gated transition; off -> off needs nothing.
		s.confirmation.change('w1', off, (s.confirmation.change('w1', off) as { token: string }).token)
		expect(s.confirmation.change('w1', off).status).toBe('saved')
	})

	it('keeps the strict validation: unknown keys and bad types are refused', () => {
		const s = setup()
		expect(() => s.confirmation.change('w1', { nope: true })).toThrow('Unknown setting')
		expect(() => s.confirmation.change('w1', { retrustOnConfigChange: 'no' })).toThrow('Invalid')
		expect(() => s.confirmation.change('w1', null)).toThrow('Invalid')
		expect(s.set).not.toHaveBeenCalled()
	})
})
