/**
 * Whether a scheduled run's browser can start, decided before any model
 * call, over a fake machine: the profile, the engine it was signed in with,
 * and a window when the job asks for one.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type BrowserEnvironmentProbes, BrowserProfileStore } from '@namzu/browser'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { browserPreflight } from '../fire/browser-preflight.js'
import { type Sandbox, sandbox } from './fixtures.js'

let sb: Sandbox
beforeEach(() => {
	sb = sandbox()
})
afterEach(() => sb.cleanup())

/** A machine made of the listed paths. */
function machine(
	paths: readonly string[],
	files: Record<string, string> = {},
): BrowserEnvironmentProbes {
	const set = new Set([...paths, ...Object.keys(files)])
	return {
		exists: (path) => set.has(path),
		readFile: (path) => files[path],
		listDir: (dir) =>
			[...set]
				.filter((path) => path.startsWith(`${dir}/`))
				.map((path) => path.slice(dir.length + 1).split('/')[0] as string),
	}
}

const LINUX = machine([])
const WSL_READY = machine(
	[
		'/proc/sys/fs/binfmt_misc/WSLInterop',
		'/run/WSL/1_interop',
		'/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
		'/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
	],
	{ '/proc/sys/kernel/osrelease': '6.18.33.2-microsoft-standard-WSL2' },
)
const WSL_NO_INTEROP = machine([], {
	'/proc/sys/kernel/osrelease': '6.18.33.2-microsoft-standard-WSL2',
})

const grant = (over: Partial<{ headed: boolean; profile: string }> = {}) => ({
	profile: over.profile ?? 'social',
	sites: { 'http://localhost:8123': 'act' as const },
	...(over.headed ? { headed: true } : {}),
})

function windowsProfile() {
	const root = join(sb.home, 'browser', 'profiles')
	mkdirSync(root, { recursive: true })
	writeFileSync(
		join(root, 'social.json'),
		JSON.stringify({
			v: 1,
			name: 'social',
			engine: 'windows-cdp',
			userDataDir: 'C:\\Users\\Someone\\AppData\\Local\\namzu\\browser\\profiles\\social',
			browser: 'chrome',
			createdAt: '2026-09-23T00:00:00.000Z',
		}),
	)
}

describe('a scheduled run’s browser', () => {
	it('is refused when the profile was never signed in to, with the command that does it', async () => {
		const verdict = await browserPreflight(grant(), sb.home, {
			env: {},
			platform: 'linux',
			probes: LINUX,
		})
		expect(verdict).toEqual({
			ok: false,
			reason:
				'browser profile social does not exist; sign in once with namzu browser login social http://localhost:8123',
		})
	})

	it('runs a local profile headless on a machine without a display', async () => {
		new BrowserProfileStore(sb.home).ensureLocal('social', 'chromium')
		const verdict = await browserPreflight(grant(), sb.home, {
			env: {},
			platform: 'linux',
			probes: LINUX,
		})
		expect(verdict.ok).toBe(true)
		if (verdict.ok) expect(verdict.engine).toBe('local')
	})

	it('is refused when the job wants a window and there is no display', async () => {
		new BrowserProfileStore(sb.home).ensureLocal('social', 'chromium')
		const verdict = await browserPreflight(grant({ headed: true }), sb.home, {
			env: {},
			platform: 'linux',
			probes: LINUX,
		})
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) expect(verdict.reason).toMatch(/no display/)
	})

	it('drives the Windows browser for a profile signed in with it, from a service with no WSL variables', async () => {
		windowsProfile()
		const verdict = await browserPreflight(grant(), sb.home, {
			env: {},
			platform: 'linux',
			probes: WSL_READY,
			exists: (path) => path === '/mnt/c/Users/Someone/AppData/Local/namzu/browser/profiles/social',
		})
		expect(verdict).toMatchObject({ ok: true, engine: 'windows' })
	})

	it('is refused when WSL interop is off, rather than starting a signed-out Linux browser', async () => {
		windowsProfile()
		const verdict = await browserPreflight(grant(), sb.home, {
			env: {},
			platform: 'linux',
			probes: WSL_NO_INTEROP,
		})
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) expect(verdict.reason).toMatch(/interop is off/)
	})

	it('is refused when the profile’s data is gone', async () => {
		windowsProfile()
		const verdict = await browserPreflight(grant(), sb.home, {
			env: {},
			platform: 'linux',
			probes: WSL_READY,
			exists: () => false,
		})
		expect(verdict.ok).toBe(false)
		if (!verdict.ok)
			expect(verdict.reason).toMatch(/has no data .* sign in again with namzu browser login social/)
	})

	it('is refused when the browser package cannot load', async () => {
		const verdict = await browserPreflight(grant(), sb.home, {
			env: {},
			load: async () => {
				throw new Error('Cannot find module')
			},
		})
		expect(verdict.ok).toBe(false)
		if (!verdict.ok) expect(verdict.reason).toMatch(/cannot be loaded .*namzu doctor/)
	})
})
