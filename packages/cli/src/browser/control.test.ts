/**
 * The session's browser under another profile and site rules for one turn —
 * a parked scheduled run continued in the TUI — and back again after.
 */

import type { PlaywrightBrowserHostOptions } from '@namzu/browser'
import { describe, expect, it } from 'vitest'
import { createBrowserControl } from './control.js'

const built: PlaywrightBrowserHostOptions[] = []
const disposed: string[] = []

class FakeHost {
	readonly profile: string
	readonly capabilities = { engine: 'fake', headless: true, screenshot: true, upload: false }
	readonly plan = { browser: 'chromium' }
	readonly running = false
	readonly warnings: string[] = []
	constructor(readonly options: PlaywrightBrowserHostOptions) {
		built.push(options)
		this.profile = options.profile ?? 'default'
	}
	async dispose() {
		disposed.push(this.profile)
	}
}

describe('BrowserControl.runAs', () => {
	it('runs under the job’s profile and sites, then puts the session’s back', async () => {
		built.length = 0
		disposed.length = 0
		const control = createBrowserControl(FakeHost as never, {
			profile: 'work',
			sites: { '*': 'ask' },
		})
		const restore = await control.runAs({
			profile: 'social',
			sites: { 'http://localhost:8123': 'act', '*': 'deny' },
		})
		expect(control.status().profile).toBe('social')
		expect(control.status().sites).toEqual({ 'http://localhost:8123': 'act', '*': 'deny' })
		expect(built.at(-1)).toMatchObject({
			profile: 'social',
			sites: { 'http://localhost:8123': 'act', '*': 'deny' },
			mode: 'interactive',
		})
		expect(disposed).toEqual(['work'])
		await restore()
		await restore()
		expect(control.status().profile).toBe('work')
		expect(control.status().sites).toEqual({ '*': 'ask' })
		expect(disposed).toEqual(['work', 'social'])
	})

	it('builds a scheduled run’s host unattended', () => {
		built.length = 0
		createBrowserControl(FakeHost as never, { profile: 'social', mode: 'unattended' })
		expect(built[0]?.mode).toBe('unattended')
	})

	it('refuses a name that is not a profile name', async () => {
		const control = createBrowserControl(FakeHost as never, {})
		await expect(control.runAs({ profile: 'Not Valid', sites: {} })).rejects.toThrow(/profile name/)
	})
})
