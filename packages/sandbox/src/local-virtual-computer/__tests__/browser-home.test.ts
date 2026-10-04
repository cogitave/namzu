import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const {
	bootstrapBrowserHome,
	browserLaunchArguments,
	request,
	HOME_URL,
	MARKER_BASE,
} = require('../../../local-computer/browser-home.cjs')
const marker = `${MARKER_BASE}${'a'.repeat(32)}`
const target = { id: 'own-marker-tab', type: 'page', url: marker }
const presented = {
	result: { value: { url: HOME_URL, ready: 'complete', apps: 15, clock: true } },
}

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('guest browser home bootstrap', () => {
	it('finds only its exact marker tab, preserving restored pages and ordinary blank tabs', async () => {
		const restored = { id: 'restored', type: 'page', url: 'https://example.test/private-page' }
		const blank = { id: 'blank', type: 'page', url: 'about:blank' }
		const listTargets = vi
			.fn()
			.mockResolvedValueOnce([restored, blank])
			.mockResolvedValue([restored, blank, target])
		const command = vi.fn().mockResolvedValue(presented)
		const pause = vi.fn().mockResolvedValue(undefined)
		await bootstrapBrowserHome(marker, {
			listTargets,
			request: command,
			pause,
			signal: new AbortController().signal,
		})
		expect(pause).toHaveBeenCalledTimes(3)
		expect(command.mock.calls.map(([owned, method]) => [owned.id, method])).toEqual([
			['own-marker-tab', 'Page.navigate'],
			['own-marker-tab', 'Runtime.evaluate'],
			['own-marker-tab', 'Page.navigate'],
			['own-marker-tab', 'Runtime.evaluate'],
		])
		expect(command.mock.calls[0]![2]).toEqual({ url: HOME_URL })
		expect(command.mock.calls[2]![2]).toEqual({ url: 'chrome://newtab/' })
	})
	it('refuses an owned marker that was subsequently navigated to another page', async () => {
		const listTargets = vi
			.fn()
			.mockResolvedValueOnce([target])
			.mockResolvedValue([{ ...target, url: 'https://example.test/user-navigation' }])
		const command = vi.fn().mockResolvedValue({})
		await expect(
			bootstrapBrowserHome(marker, {
				listTargets,
				request: command,
				pause: async () => {},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('owned-home-tab-navigated-away')
		expect(command).toHaveBeenCalledTimes(1)
	})
	it('never substitutes another tab after its captured target closes', async () => {
		const listTargets = vi
			.fn()
			.mockResolvedValueOnce([target])
			.mockResolvedValue([{ ...target, id: 'different-tab' }])
		const command = vi.fn().mockResolvedValue({})
		await expect(
			bootstrapBrowserHome(marker, {
				listTargets,
				request: command,
				pause: async () => {},
				signal: new AbortController().signal,
			}),
		).rejects.toThrow('owned-home-tab-closed')
		expect(command).toHaveBeenCalledTimes(1)
	})
	it('waits for the trusted native catalogue, then accepts all fifteen real launchers', async () => {
		const command = vi
			.fn()
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({
				result: { value: { url: HOME_URL, ready: 'complete', apps: 0, clock: true } },
			})
			.mockResolvedValue(presented)
		await bootstrapBrowserHome(marker, {
			listTargets: async () => [target],
			request: command,
			pause: async () => {},
			signal: new AbortController().signal,
		})
		expect(command.mock.calls.map((call) => call[1])).toEqual([
			'Page.navigate',
			'Runtime.evaluate',
			'Runtime.evaluate',
			'Page.navigate',
			'Runtime.evaluate',
		])
	})
	it('does not report readiness from the initial literal extension page', async () => {
		let enter!: () => void
		const entered = new Promise<void>((resolve) => {
			enter = resolve
		})
		let present!: (value: typeof presented) => void
		const nativePage = new Promise<typeof presented>((resolve) => {
			present = resolve
		})
		let evaluations = 0
		const command = vi.fn(async (_target, method) => {
			if (method !== 'Runtime.evaluate') return {}
			if (++evaluations === 1) return presented
			enter()
			return nativePage
		})
		let ready = false
		const operation = bootstrapBrowserHome(marker, {
			listTargets: async () => [target],
			request: command,
			pause: async () => {},
			signal: new AbortController().signal,
		}).then(() => {
			ready = true
		})
		await entered
		expect(ready).toBe(false)
		present(presented)
		await operation
		expect(ready).toBe(true)
	})
	it('terminates on the deterministic deadline if its marker never appears', async () => {
		vi.useFakeTimers()
		const controller = new AbortController()
		const deadline = setTimeout(() => controller.abort(), 15000)
		const command = vi.fn()
		const operation = bootstrapBrowserHome(marker, {
			listTargets: async () => [{ id: 'user', type: 'page', url: 'about:blank' }],
			request: command,
			signal: controller.signal,
		})
		const rejected = expect(operation).rejects.toThrow('home-startup-aborted')
		await vi.advanceTimersByTimeAsync(15000)
		await rejected
		clearTimeout(deadline)
		expect(command).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
	it('rejects a malformed or remote marker before calling any runtime port', async () => {
		const listTargets = vi.fn()
		await expect(
			bootstrapBrowserHome('http://example.test/namzu-home-bootstrap', { listTargets }),
		).rejects.toThrow('browser-marker-invalid')
		expect(listTargets).not.toHaveBeenCalled()
	})
	it('refuses CDP descriptors outside the exact guest-loopback page endpoint', async () => {
		const socket = vi.fn()
		vi.stubGlobal('WebSocket', socket)
		for (const webSocketDebuggerUrl of [
			'ws://example.test:9222/devtools/page/own',
			'ws://127.0.0.1:9222/devtools/page/other',
			'ws://127.0.0.1:2025/devtools/page/own',
			'ws://user:secret@127.0.0.1:9222/devtools/page/own',
		])
			await expect(
				request(
					{ id: 'own', webSocketDebuggerUrl },
					'Page.navigate',
					{ url: 'chrome://newtab/' },
					new AbortController().signal,
				),
			).rejects.toThrow('browser-target-invalid')
		expect(socket).not.toHaveBeenCalled()
	})
	it('preserves explicit literal addresses and marks only requested native New Tabs', () => {
		const address = 'https://example.test/?q=literal spaces&text=$(exit 99)'
		const args = ['--user-data-dir=/home/namzu/.config/chromium', address]
		expect(browserLaunchArguments(args, 'b'.repeat(32))).toMatchObject({
			homeRequested: false,
			args,
		})
		expect(browserLaunchArguments([args[0], 'chrome://newtab/'], 'c'.repeat(32))).toMatchObject({
			homeRequested: true,
			args: [args[0], `${MARKER_BASE}${'c'.repeat(32)}`],
		})
		expect(args[1]).toBe(address)
	})
})
