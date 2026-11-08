import { describe, expect, it } from 'vitest'
import { RECOVERY_RELOAD_URL, recoveryCardPage, recoveryCardText } from './recovery-card.js'

describe('recoveryCardText', () => {
	it('names the diagnostic shortcut for the platform', () => {
		const cause = { kind: 'load-failed', errorCode: -6 } as const
		expect(recoveryCardText(cause, 'linux').details.at(-1)).toBe(
			'Press Ctrl+Shift+L to open the diagnostic logs, which show what Namzu recorded.',
		)
		expect(recoveryCardText(cause, 'darwin').details.at(-1)).toContain('Cmd+Shift+L')
	})

	it('says what happened without raw identifiers', () => {
		const crash = recoveryCardText(
			{ kind: 'crashed', reason: 'oom', exitCode: 9, reloads: 3 },
			'win32',
		)
		expect(crash.details[0]).toBe('The window’s process ran out of memory (exit code 9).')
		expect(crash.details[1]).toBe('Namzu reloaded the window 3 times in the last minute.')
		expect(recoveryCardText({ kind: 'hung', reloads: 1 }, 'win32').details[1]).toContain('once')
		expect(
			recoveryCardText({ kind: 'load-failed', errorCode: -102 }, 'win32').details[0],
		).toContain('development server')
	})
})

describe('recoveryCardPage', () => {
	const page = recoveryCardPage(
		{ kind: 'crashed', reason: 'crashed', exitCode: 5, reloads: 3 },
		{ platform: 'linux', appearance: 'dark' },
	)

	it('has no script and forbids one', () => {
		expect(page).not.toMatch(/<script/i)
		expect(page).toContain("default-src 'none'")
	})

	it('puts the alert on a div inside main, with a focused Reload link and a drag strip', () => {
		expect(page).toMatch(/<main>\s*<div role="alert"><h1>/)
		expect(page).toContain(`<a href="${RECOVERY_RELOAD_URL}" autofocus>Reload</a>`)
		expect(page).toMatch(/\.drag\{[^}]*height:36px[^}]*-webkit-app-region:drag/)
	})

	it('follows the scheme main last heard', () => {
		const light = recoveryCardPage(
			{ kind: 'hung', reloads: 3 },
			{ platform: 'linux', appearance: 'light' },
		)
		expect(page).toContain('background:#171717')
		expect(light).toContain('background:#f7f7f7')
	})

	it('escapes what it prints', () => {
		const hostile = recoveryCardPage(
			{ kind: 'crashed', reason: '<b>', exitCode: 1, reloads: 1 },
			{ platform: 'linux', appearance: 'dark' },
		)
		expect(hostile).not.toContain('<b>')
	})
})
