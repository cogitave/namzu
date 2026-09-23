import { describe, expect, it, vi } from 'vitest'

import type { BrowserControl, BrowserStatus } from '../browser/control.js'
import { browserSiteNotes, describeBrowserHandoff, runBrowserSlash } from './browser-notices.js'

const HANDOFF = {
	kind: 'human-required' as const,
	reason: 'https://github.com is showing a sign-in page',
	detail: {
		tool: 'browser',
		cause: 'sign-in',
		origin: 'https://github.com',
		profile: 'work',
		loginCommand: 'namzu browser login work https://github.com/login',
	},
}

const STATUS: BrowserStatus = {
	profile: 'work',
	engine: 'windows-cdp',
	browser: 'chrome',
	headless: false,
	running: true,
	warnings: [],
	sites: { 'https://github.com': 'ask', 'https://*.example.com': 'act', '*': 'ask' },
	keepOpen: false,
}

describe('the browser handoff notice', () => {
	it('sends the operator to the window when there is one', () => {
		expect(describeBrowserHandoff(HANDOFF, STATUS)).toBe(
			'The browser needs you: https://github.com is showing a sign-in page.\nSign in to https://github.com in the browser window (profile work), then press Enter to continue · Esc to stop.',
		)
	})

	it('names the right thing to do for a check', () => {
		const text = describeBrowserHandoff(
			{ ...HANDOFF, detail: { ...HANDOFF.detail, cause: 'captcha' } },
			STATUS,
		)
		expect(text).toContain('Complete the check on https://github.com in the browser window')
	})

	it('gives the login command when the browser has no window', () => {
		const text = describeBrowserHandoff(HANDOFF, { ...STATUS, headless: true })
		expect(text).toContain('  namzu browser login work https://github.com/login\n')
		expect(text).toContain('then press Enter here to continue · Esc to stop.')
		expect(text).not.toContain('browser window (profile')
	})

	it('leaves another tool’s handoff to the generic notice', () => {
		expect(describeBrowserHandoff({ kind: 'human-required', reason: 'x' }, STATUS)).toBeUndefined()
	})

	it('shows page-controlled text inert', () => {
		const text = describeBrowserHandoff(
			{ ...HANDOFF, detail: { ...HANDOFF.detail, origin: 'https://a.example\u001b[2J' } },
			STATUS,
		)
		expect(text).not.toContain('\u001b')
	})
})

describe('the site rule on the review screen', () => {
	it('names the rule, profile and engine for each browser call', () => {
		expect(
			browserSiteNotes(
				[
					{ name: 'browser', input: { action: 'navigate', url: 'https://github.com/x' } },
					{
						name: 'browser_act',
						input: { action: 'click', ref: 'e1', origin: 'https://a.example.com' },
					},
					{ name: 'browser', input: { action: 'navigate', url: 'https://other.example/' } },
					{ name: 'browser', input: { action: 'back' } },
					{ name: 'bash', input: { command: 'ls' } },
				],
				STATUS,
			),
		).toEqual([
			'site rule: https://github.com → ask · profile work · windows-cdp',
			'site rule: https://a.example.com (https://*.example.com) → act · profile work · windows-cdp',
			'site rule: https://other.example (any other site) → ask · profile work · windows-cdp',
		])
	})

	it('says nothing without a browser', () => {
		expect(browserSiteNotes([{ name: 'bash', input: {} }], undefined)).toEqual([])
	})
})

function control(): BrowserControl & { switched: string[] } {
	const switched: string[] = []
	let profile = 'work'
	return {
		switched,
		host: {} as never,
		status: () => ({ ...STATUS, profile }),
		switchProfile: vi.fn(async (name: string) => {
			if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`"${name}" is not a profile name`)
			switched.push(name)
			profile = name
			return { ...STATUS, profile }
		}),
		release: async () => {},
		dispose: async () => {},
	}
}

describe('/browser', () => {
	it('shows engine, profile and sites', async () => {
		const { text } = await runBrowserSlash(control(), [], { busy: false })
		expect(text).toContain('Browser: windows-cdp (chrome) · visible window · running')
		expect(text).toContain('Profile: work')
		expect(text).toContain('Sites: https://github.com ask · https://*.example.com act · * ask')
		expect((await runBrowserSlash(control(), ['status'], { busy: false })).text).toBe(text)
	})

	it('switches profile and reports the one to keep', async () => {
		const c = control()
		const answer = await runBrowserSlash(c, ['profile', 'personal'], { busy: false })
		expect(answer.profile).toBe('personal')
		expect(answer.text).toContain('profile personal from the next browser call on')
		expect(c.switched).toEqual(['personal'])
		expect((await runBrowserSlash(c, ['profile'], { busy: false })).text).toContain(
			'Profile: personal.',
		)
	})

	it('refuses a switch during a turn, and a bad name', async () => {
		const c = control()
		expect((await runBrowserSlash(c, ['profile', 'x'], { busy: true })).text).toMatch(
			/while a turn is running/,
		)
		const bad = await runBrowserSlash(c, ['profile', 'Bad Name'], { busy: false })
		expect(bad.profile).toBeUndefined()
		expect(bad.text).toMatch(/not a profile name/)
		expect(c.switched).toEqual([])
	})

	it('explains a session without a browser, and prints usage for anything else', async () => {
		expect((await runBrowserSlash(undefined, [], { busy: false })).text).toMatch(
			/This session has no browser/,
		)
		expect((await runBrowserSlash(control(), ['open'], { busy: false })).text).toMatch(/^Usage:/)
	})
})
