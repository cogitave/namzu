import { describe, expect, it, vi } from 'vitest'
import { PlaywrightBrowserHost } from '../host.js'

/**
 * `peekHumanRequired` reads the page that is already open and answers whether
 * it still asks for a person. It must never act: no navigation, typing,
 * clicks, cookies or storage.
 */

function fakePage(url: string) {
	const forbidden = {
		goto: vi.fn(),
		reload: vi.fn(),
		click: vi.fn(),
		fill: vi.fn(),
		type: vi.fn(),
		keyboard: { type: vi.fn(), press: vi.fn() },
		goBack: vi.fn(),
		setContent: vi.fn(),
		cookies: vi.fn(),
		storageState: vi.fn(),
	}
	const main = {}
	const page = {
		...forbidden,
		url: () => url,
		isClosed: () => false,
		title: async () => 'Welcome',
		evaluate: vi.fn(async () => ({ passwordFields: 0, oneTimeCodeFields: 0 })),
		frames: () => [main],
		mainFrame: () => main,
	}
	return { page, forbidden }
}

function hostWith(url: string | undefined, running = true) {
	const host = new PlaywrightBrowserHost({
		env: {},
		platform: 'linux',
		signInDetection: 'address',
	}) as unknown as {
		context: unknown
		tabs: Map<string, unknown>
		activeTabId: string | undefined
		peekHumanRequired(): Promise<'still-required' | 'cleared' | 'unknown'>
	}
	const fake = url === undefined ? undefined : fakePage(url)
	if (running) host.context = { cookies: vi.fn(), storageState: vi.fn() }
	if (fake) {
		host.tabs = new Map([['t1', { id: 't1', page: fake.page }]])
		host.activeTabId = 't1'
	}
	return { host, fake }
}

describe('peekHumanRequired', () => {
	it('says still-required while the page is a sign-in address', async () => {
		const { host } = hostWith('https://example.test/login')
		expect(await host.peekHumanRequired()).toBe('still-required')
	})

	it('says cleared once the page has moved on', async () => {
		const { host } = hostWith('https://example.test/dashboard')
		expect(await host.peekHumanRequired()).toBe('cleared')
	})

	it('says unknown when the browser is not running or no page is open', async () => {
		expect(await hostWith('https://example.test/login', false).host.peekHumanRequired()).toBe(
			'unknown',
		)
		expect(await hostWith(undefined).host.peekHumanRequired()).toBe('unknown')
		expect(await hostWith('about:blank').host.peekHumanRequired()).toBe('unknown')
	})

	it('never navigates, types, clicks or reads cookies or storage', async () => {
		const { host, fake } = hostWith('https://example.test/dashboard')
		await host.peekHumanRequired()
		for (const [name, spy] of Object.entries(fake?.forbidden ?? {})) {
			if ('mock' in spy) expect(spy, name).not.toHaveBeenCalled()
		}
		expect(fake?.forbidden.keyboard.type).not.toHaveBeenCalled()
		expect(fake?.forbidden.keyboard.press).not.toHaveBeenCalled()
		const context = (host as unknown as { context: { cookies: unknown; storageState: unknown } })
			.context
		expect(context.cookies).not.toHaveBeenCalled()
		expect(context.storageState).not.toHaveBeenCalled()
	})
})
