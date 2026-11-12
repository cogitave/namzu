import { describe, expect, it } from 'vitest'
import { SESSION_CHILD_ENV, startedBySession, withSessionChildMarker } from './session-child.js'

describe('the marker on a process a session started', () => {
	it('is named, and added without touching the environment it was given', () => {
		const given = { PATH: '/usr/bin', HOME: '/home/someone' }
		const marked = withSessionChildMarker(given)
		expect(SESSION_CHILD_ENV).toBe('NAMZU_STARTED_BY_SESSION')
		expect(marked).toMatchObject({
			PATH: '/usr/bin',
			HOME: '/home/someone',
			[SESSION_CHILD_ENV]: '1',
		})
		expect(given).not.toHaveProperty(SESSION_CHILD_ENV)
	})

	it('cannot be taken back by a value the caller supplied', () => {
		expect(withSessionChildMarker({ [SESSION_CHILD_ENV]: '0' })[SESSION_CHILD_ENV]).toBe('1')
		expect(withSessionChildMarker({ [SESSION_CHILD_ENV]: undefined })[SESSION_CHILD_ENV]).toBe('1')
	})

	it('is the one spelling on Windows, where names do not differ by case', () => {
		const marked = withSessionChildMarker({ namzu_started_by_session: '0', Path: 'C:\\x' }, 'win32')
		expect(
			Object.keys(marked).filter((k) => k.toLowerCase() === SESSION_CHILD_ENV.toLowerCase()),
		).toEqual([SESSION_CHILD_ENV])
		expect(startedBySession({ namzu_started_by_session: '1' }, 'win32')).toBe(true)
		expect(startedBySession({ namzu_started_by_session: '1' }, 'linux')).toBe(false)
	})

	it('is read as present only when it says so', () => {
		expect(startedBySession({ [SESSION_CHILD_ENV]: '1' })).toBe(true)
		expect(startedBySession({ [SESSION_CHILD_ENV]: 'yes' })).toBe(true)
		expect(startedBySession({ [SESSION_CHILD_ENV]: '' })).toBe(false)
		expect(startedBySession({ [SESSION_CHILD_ENV]: '0' })).toBe(false)
		expect(startedBySession({})).toBe(false)
	})
})
