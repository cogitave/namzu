import { describe, expect, it } from 'vitest'

import { describeBrowserEngine } from '../browser.js'
import { browserEngineCheck, builtInDoctorChecks } from '../index.js'

type BrowserModule = typeof import('@namzu/browser')

function moduleWith(plan: Record<string, unknown>): () => Promise<BrowserModule> {
	return async () =>
		({
			detectBrowserEnvironment: () => plan,
			runnableBrowserPlan: (p: unknown) => p,
		}) as unknown as BrowserModule
}

const WINDOWS = {
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

describe('browser.engine', () => {
	it('is registered after browser.installed', () => {
		const ids = builtInDoctorChecks.map((check) => check.id)
		expect(ids.indexOf('browser.engine')).toBe(ids.indexOf('browser.installed') + 1)
		expect(browserEngineCheck.category).toBe('custom')
	})

	it('names the Windows browser driven from WSL', async () => {
		const result = await describeBrowserEngine({}, 'linux', moduleWith(WINDOWS))
		expect(result.status).toBe('pass')
		expect(result.message).toBe(
			'windows-cdp: Google Chrome on Windows (C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe), driven from WSL through the PowerShell bridge (nat networking), a visible window',
		)
	})

	it('warns, and says why, when no browser can run', async () => {
		const result = await describeBrowserEngine(
			{},
			'linux',
			moduleWith({
				engine: 'local',
				platform: 'linux',
				browser: 'chromium',
				headless: true,
				display: false,
				warnings: [],
				unavailableReason: 'engine "windows" drives a Windows browser from WSL; this is not WSL.',
			}),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toContain('this is not WSL')
		expect(result.remediation).toBe('namzu browser install')
	})

	it('warns when detection fell back, repeating its warning', async () => {
		const result = await describeBrowserEngine(
			{},
			'linux',
			moduleWith({
				engine: 'local',
				platform: 'wsl',
				browser: 'chrome',
				channel: 'chrome',
				headless: false,
				display: true,
				warnings: ['Using Chromium inside WSL: WSL interop is off.'],
			}),
		)
		expect(result.status).toBe('warn')
		expect(result.message).toBe(
			'local-chrome: Google Chrome inside WSL, a visible window (Using Chromium inside WSL: WSL interop is off.)',
		)
	})

	it('reads the real package on this machine without launching anything', async () => {
		const result = await describeBrowserEngine(process.env)
		expect(['pass', 'warn']).toContain(result.status)
		expect(result.message).toMatch(/^(windows-cdp|local-\w+|no browser can run here)/)
	})
})
