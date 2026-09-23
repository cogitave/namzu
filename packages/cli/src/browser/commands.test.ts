import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as realBrowser from '@namzu/browser'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import type { CommandContext } from '../commands/types.js'
import type { NamzuCliConfig } from '../config/schema.js'
import { type BrowserCommandDeps, browserCommand } from './commands.js'

type BrowserModule = typeof import('@namzu/browser')

const WINDOWS_PLAN = {
	engine: 'windows-cdp',
	platform: 'wsl',
	browser: 'chrome',
	executable: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
	windowsExecutable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
	powershell: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
	mountRoot: '/mnt/',
	networkingMode: 'nat',
	headless: false,
	display: true,
	warnings: [],
}

interface FakeWorld {
	plan: Record<string, unknown>
	built: Record<string, unknown>[]
	observed: unknown[]
	disposed: number
	running: boolean
	observeError?: unknown
	closeAfterMs?: number
}

function fakeModule(world: FakeWorld): BrowserModule {
	class FakeHost {
		constructor(options: Record<string, unknown>) {
			world.built.push(options)
			// The profile a real launch would write, so markLogin has one.
			new realBrowser.BrowserProfileStore(String(options.home)).ensureLocal(
				String(options.profile),
				'chrome',
			)
		}
		get running() {
			return world.running
		}
		async observe(action: unknown) {
			world.observed.push(action)
			world.running = true
			if (world.closeAfterMs !== undefined) {
				setTimeout(() => {
					world.running = false
				}, world.closeAfterMs)
			}
			if (world.observeError) throw world.observeError
			return { page: { origin: 'null', url: 'about:blank', title: '', tab: 't1' } }
		}
		async dispose() {
			world.disposed += 1
			world.running = false
		}
	}
	return {
		...realBrowser,
		PlaywrightBrowserHost: FakeHost,
		detectBrowserEnvironment: () => world.plan,
		runnableBrowserPlan: (plan: unknown) => plan,
	} as unknown as BrowserModule
}

function harness(world: Partial<FakeWorld> = {}, config: NamzuCliConfig = {}) {
	const home = mkdtempSync(join(tmpdir(), 'namzu-browser-cmd-'))
	homes.push(home)
	const full: FakeWorld = {
		plan: WINDOWS_PLAN,
		built: [],
		observed: [],
		disposed: 0,
		running: false,
		...world,
	}
	const out: unknown[] = []
	const errors: { message: string; details?: unknown }[] = []
	const ctx: CommandContext = {
		config,
		formatter: {
			name: 'text',
			print: (data) => out.push(data),
			info: () => {},
			error: (payload) => errors.push(payload),
		},
	}
	let pressEnter: () => void = () => {}
	const installs: (readonly string[])[] = []
	const deps: BrowserCommandDeps = {
		load: async () => fakeModule(full),
		env: { NAMZU_HOME: home },
		platform: 'linux',
		waitForEnter: (signal) =>
			new Promise((resolve) => {
				pressEnter = resolve
				signal.addEventListener('abort', () => {})
			}),
		pollMs: 10,
		spawnInstall: async (args) => {
			installs.push(args)
			return 0
		},
	}
	const run = (...argv: string[]) => browserCommand(ctx, argv, deps)
	const text = () =>
		out.map((o) => (typeof o === 'string' ? o : ((o as { text?: string }).text ?? ''))).join('\n')
	return { home, world: full, out, errors, run, text, enter: () => pressEnter(), installs }
}

const homes: string[] = []
afterEach(() => {
	for (const home of homes.splice(0)) removeTempDir(home)
})

describe('namzu browser login', () => {
	it('opens a visible window on the profile at the url, and returns on Enter', async () => {
		const h = harness({
			observeError: { code: 'browser_human_required', reason: 'sign-in', message: 'x' },
		})
		const done = h.run('login', 'namzu-test-a', 'github.com/login')
		await new Promise((r) => setTimeout(r, 30))
		expect(h.world.built).toEqual([
			expect.objectContaining({
				profile: 'namzu-test-a',
				home: h.home,
				mode: 'interactive',
				sites: { '*': 'act' },
				plan: WINDOWS_PLAN,
			}),
		])
		expect(h.world.observed).toEqual([
			{ action: 'tabs', op: 'new', url: 'https://github.com/login' },
		])
		expect(h.text()).toContain('Sign in to https://github.com in the window that opened')
		h.enter()
		expect(await done).toBe(0)
		expect(h.world.disposed).toBe(1)
		expect(h.text()).toContain('Done. Profile namzu-test-a keeps what you signed in to')
		expect(h.text()).toContain('namzu schedule add … --browser namzu-test-a')
		const profile = new realBrowser.BrowserProfileStore(h.home).get('namzu-test-a')
		expect(profile?.lastLoginAt).toBeDefined()
	})

	it('returns when the window is closed', async () => {
		const h = harness({ closeAfterMs: 40 })
		expect(await h.run('login', 'namzu-test-b')).toBe(0)
		expect(h.world.observed).toEqual([{ action: 'snapshot' }])
		expect(h.text()).toContain('Window closed.')
	})

	it('refuses where no window can open, and says what to do', async () => {
		const h = harness({
			plan: {
				engine: 'local',
				platform: 'linux',
				browser: 'chromium',
				headless: false,
				display: false,
				warnings: [],
				unavailableReason: 'There is no display for a visible window.',
			},
		})
		expect(await h.run('login', 'work', 'https://example.com')).toBe(69)
		expect(h.errors[0]?.message).toContain('Cannot open a browser window here')
		expect(JSON.stringify(h.errors[0]?.details)).toContain('ssh -X')
		expect(h.world.built).toEqual([])
	})

	it('reports a profile another process holds', async () => {
		const h = harness({
			observeError: { code: 'browser_profile_busy', message: 'Browser profile "work" is in use' },
		})
		expect(await h.run('login', 'work')).toBe(69)
		expect(h.errors[0]?.message).toContain('is in use')
		expect(h.world.disposed).toBe(1)
	})

	it.each([
		[['login'], /usage/],
		[['login', 'Work'], /not a profile name/],
		[['login', 'work', 'file:///etc/passwd'], /not allowed|refused|scheme/i],
		[['login', 'work', 'https://a.example', 'extra'], /usage/],
		[['frobnicate'], /unknown browser command/],
	])('refuses %j', async (argv, message) => {
		const h = harness()
		expect(await h.run(...argv)).toBe(64)
		expect(h.errors[0]?.message).toMatch(message)
	})
})

describe('namzu browser list, status, remove, install', () => {
	it('lists profiles', async () => {
		const h = harness()
		new realBrowser.BrowserProfileStore(h.home).ensureLocal('namzu-test-a', 'chromium')
		expect(await h.run('list')).toBe(0)
		expect(h.text()).toContain("namzu-test-a  Playwright's Chromium (local)")
		expect(h.text()).toContain('never signed in')
		const json = harness()
		new realBrowser.BrowserProfileStore(json.home).ensureLocal('x', 'chromium')
		await json.run('list', '--json')
		expect(JSON.parse(json.text())).toMatchObject({
			v: 1,
			profiles: [{ name: 'x', engine: 'local', inUse: false }],
		})
	})

	it('says which browser runs here, with the config’s profile and sites', async () => {
		const h = harness(
			{},
			{ browser: { defaultProfile: 'work', sites: { 'https://github.com': 'act', '*': 'ask' } } },
		)
		expect(await h.run('status', 'work')).toBe(0)
		expect(h.text()).toContain(
			'Engine: windows-cdp: Google Chrome on Windows (C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe), driven from WSL through the PowerShell bridge (nat networking), a visible window',
		)
		expect(h.text()).toContain('Default profile: work')
		expect(h.text()).toContain('Sites: https://github.com act · * ask')
		expect(h.text()).toContain('Profile work: does not exist yet.')
	})

	it('removes a profile only when confirmed', async () => {
		const h = harness()
		new realBrowser.BrowserProfileStore(h.home).ensureLocal('namzu-test-a', 'chromium')
		expect(await h.run('remove', 'namzu-test-a')).toBe(64)
		expect(h.errors[0]?.message).toContain('Pass --yes')
		expect(await h.run('remove', 'namzu-test-a', '--yes')).toBe(0)
		expect(new realBrowser.BrowserProfileStore(h.home).get('namzu-test-a')).toBeUndefined()
		expect(await h.run('remove', 'namzu-test-a', '--yes')).toBe(1)
	})

	it('installs Chromium only when the tools would use it', async () => {
		const h = harness()
		expect(await h.run('install')).toBe(0)
		expect(h.installs).toEqual([])
		expect(h.text()).toContain('Nothing to install')
		const local = harness({
			plan: {
				engine: 'local',
				platform: 'linux',
				browser: 'chromium',
				headless: true,
				display: false,
				warnings: [],
			},
		})
		expect(await local.run('install', '--dry-run')).toBe(0)
		expect(local.installs).toEqual([['--dry-run']])
	})
})
