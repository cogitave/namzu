import { describe, expect, it } from 'vitest'
import { recordingAvailability } from './availability.js'

const ok = {
	platform: 'win32' as const,
	env: { SESSIONNAME: 'Console' },
	helper: { present: true, caps: ['a11y', 'watch'] },
	enabled: true,
}

describe('availability', () => {
	it('offers recording on a native Windows desktop with the helper and the switch on', () => {
		expect(recordingAvailability(ok)).toEqual({ available: true })
	})

	it.each(['darwin', 'linux', 'freebsd'] as const)('hides the item on %s', (platform) => {
		expect(recordingAvailability({ ...ok, platform })).toEqual({
			available: false,
			reason: 'platform',
		})
	})

	it('hides the item in WSL, which is Linux under Windows', () => {
		expect(recordingAvailability({ ...ok, platform: 'linux', wsl: true }).reason).toBe('platform')
	})

	it('refuses a remote desktop session with the sentence, and says which signal told it', () => {
		const refused = recordingAvailability({ ...ok, env: { SESSIONNAME: 'RDP-Tcp#12' } })
		expect(refused).toEqual({
			available: false,
			reason: 'remote-session',
			message: 'Recording does not work in a remote session.',
		})
	})

	it('refuses a session that names a remote client even when its session name is missing', () => {
		expect(recordingAvailability({ ...ok, env: { CLIENTNAME: 'LAPTOP-7' } }).reason).toBe(
			'remote-session',
		)
		expect(
			recordingAvailability({ ...ok, env: { SESSIONNAME: 'Console', CLIENTNAME: 'LAPTOP-7' } })
				.available,
		).toBe(true)
	})

	it('treats the console session as local', () => {
		expect(recordingAvailability({ ...ok, env: { SESSIONNAME: 'Console' } }).available).toBe(true)
		expect(recordingAvailability({ ...ok, env: {} }).available).toBe(true)
	})

	it('hides the item when the helper is missing', () => {
		expect(recordingAvailability({ ...ok, helper: { present: false } }).reason).toBe(
			'helper-missing',
		)
	})

	it('hides the item when the helper in use cannot watch', () => {
		expect(recordingAvailability({ ...ok, helper: { present: true, caps: ['a11y'] } }).reason).toBe(
			'helper-without-watch',
		)
	})

	it('hides the item when the person switched it off in Settings', () => {
		expect(recordingAvailability({ ...ok, enabled: false }).reason).toBe('switched-off')
	})

	it('checks the platform before anything that could only be asked on Windows', () => {
		expect(
			recordingAvailability({
				...ok,
				platform: 'linux',
				env: { SESSIONNAME: 'RDP-Tcp#1' },
				helper: { present: false },
			}).reason,
		).toBe('platform')
	})
})
