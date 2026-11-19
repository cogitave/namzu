import { describe, expect, it, vi } from 'vitest'
import { browserStatus } from './status.js'

type Mod = typeof import('@namzu/browser')

/** A stand-in for the browser package: detection answers a plan that the test fixes. */
function modWith(plan: Record<string, unknown>) {
	const detect = vi.fn(() => plan)
	const mod = {
		detectBrowserEnvironment: detect,
		runnableBrowserPlan: (value: unknown) => value,
	} as unknown as Mod
	return { mod, detect }
}

const local = {
	engine: 'local',
	platform: 'linux',
	browser: 'chrome',
	headless: false,
	warnings: [] as string[],
}

describe('the engine browser in the Connected browsers table', () => {
	it('names a Windows browser without the engine id, path or bridge', async () => {
		const { mod } = modWith({
			...local,
			engine: 'windows-cdp',
			platform: 'wsl',
			windowsExecutable: 'C:\\Chrome\\chrome.exe',
			networkingMode: 'mirrored',
		})
		const status = await browserStatus({
			enabled: true,
			installed: async () => true,
			load: async () => mod,
		})
		expect(status.text).toBe('Google Chrome on Windows, with a visible window.')
	})

	it('says the tools are off without loading anything', async () => {
		const load = vi.fn()
		const status = await browserStatus({ enabled: false, load })
		expect(status).toMatchObject({ enabled: false, state: 'off' })
		expect(load).not.toHaveBeenCalled()
	})

	it('says when the browser package is not installed', async () => {
		const load = vi.fn()
		const status = await browserStatus({ enabled: true, installed: async () => false, load })
		expect(status.state).toBe('missing')
		expect(load).not.toHaveBeenCalled()
	})

	it('describes the browser that would run and hands the chosen engine to detection', async () => {
		const { mod, detect } = modWith(local)
		const status = await browserStatus({
			enabled: true,
			engine: 'windows',
			headless: 'always',
			installed: async () => true,
			load: async () => mod,
			env: {},
			platform: 'linux',
		})
		expect(status.state).toBe('ready')
		expect(status.text).toBe('Google Chrome on this computer, with a visible window.')
		expect(detect).toHaveBeenCalledWith({}, 'linux', undefined, {
			engine: 'windows',
			headless: 'always',
			mode: 'interactive',
		})
	})

	it('carries a warning and an unavailable reason in words', async () => {
		const warned = modWith({ ...local, warnings: ['Chromium inside WSL.'] })
		expect(
			(
				await browserStatus({
					enabled: true,
					installed: async () => true,
					load: async () => warned.mod,
				})
			).state,
		).toBe('warning')
		const none = modWith({ ...local, unavailableReason: 'no display' })
		const status = await browserStatus({
			enabled: true,
			installed: async () => true,
			load: async () => none.mod,
		})
		expect(status).toMatchObject({
			state: 'unavailable',
			text: 'No browser can run here: no display',
		})
	})

	it('reports a package that fails to load as unavailable', async () => {
		const status = await browserStatus({
			enabled: true,
			installed: async () => true,
			load: async () => {
				throw new Error('boom')
			},
		})
		expect(status.state).toBe('unavailable')
	})
})
