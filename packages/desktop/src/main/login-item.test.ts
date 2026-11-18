import { describe, expect, it } from 'vitest'
import {
	type LoginItemApi,
	applyLoginItem,
	loginItemAvailable,
	readLoginItem,
} from './login-item.js'

function fake(behaviour: 'keeps' | 'refuses' | 'throws' = 'keeps', start = false) {
	let state = start
	const api: LoginItemApi = {
		get: () => ({ openAtLogin: state }),
		set: ({ openAtLogin }) => {
			if (behaviour === 'throws') throw new Error('denied')
			if (behaviour === 'keeps') state = openAtLogin
		},
	}
	return api
}

describe('start at sign-in', () => {
	it('is offered on Windows and macOS for an installed app only', () => {
		expect(loginItemAvailable('win32', true)).toBe(true)
		expect(loginItemAvailable('darwin', true)).toBe(true)
		expect(loginItemAvailable('linux', true)).toBe(false)
		expect(loginItemAvailable('win32', false)).toBe(false)
	})

	it('reports what the system says after the change, with no problem when it kept it', () => {
		const api = fake()
		expect(applyLoginItem(api, true, 'win32')).toEqual({ enabled: true })
		expect(readLoginItem(api)).toBe(true)
		expect(applyLoginItem(api, false, 'win32')).toEqual({ enabled: false })
	})

	it('says so in one line when the system did not keep the change', () => {
		const refused = applyLoginItem(fake('refuses'), true, 'win32')
		expect(refused.enabled).toBe(false)
		expect(refused.problem).toBe(
			'Windows did not allow Namzu to start at sign-in, so it stays off.',
		)
		const stuck = applyLoginItem(fake('refuses', true), false, 'darwin')
		expect(stuck.enabled).toBe(true)
		expect(stuck.problem).toContain('macOS kept Namzu in its startup list')
	})

	it('reads the system back even when asking it threw', () => {
		expect(applyLoginItem(fake('throws'), true, 'win32').enabled).toBe(false)
	})
})
