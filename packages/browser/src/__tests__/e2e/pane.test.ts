import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PlaywrightBrowserHost } from '../../host.js'
import { createPaneProvider } from '../../pane-provider.js'
import { type FixtureServer, startFixtureServer } from './fixture-server.js'
import { type ChromiumPane, startChromiumPane } from './pane-chromium-channel.js'

/**
 * The host driving tabs it was handed by a pane channel, over a real
 * Chromium's protocol. The whole behaviour contract runs on this path in
 * `host.test.ts` with NAMZU_BROWSER_E2E_PANE=1; this file holds what is
 * particular to a pane: who opens and closes tabs, what crosses the channel,
 * and what stays open when the host lets go.
 *
 * Opt in with NAMZU_BROWSER_E2E=1, like the other end-to-end suites.
 */
const E2E = process.env.NAMZU_BROWSER_E2E === '1'

function refOf(text: string, pattern: RegExp): string {
	const line = text.split('\n').find((l) => pattern.test(l))
	const ref = line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : undefined
	if (!ref) throw new Error(`no ref for ${pattern} in:\n${text}`)
	return ref
}

describe.skipIf(!E2E)('PlaywrightBrowserHost on a pane channel', { timeout: 60_000 }, () => {
	let server: FixtureServer
	beforeAll(async () => {
		server = await startFixtureServer()
	})
	afterAll(async () => {
		await server?.close()
	})

	const hostOn = (pane: ChromiumPane) =>
		new PlaywrightBrowserHost({
			provider: createPaneProvider(pane),
			sites: { [server.allowed]: 'act', '*': 'ask' },
			signInDetection: 'address',
		})

	it('drives a tab the pane already has, reads it with refs, and clicks by ref', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = hostOn(pane)
		try {
			expect(host.capabilities.engine).toBe('pane')
			expect(host.running).toBe(false)
			const opened = await host.observe({ action: 'navigate', url: `${server.allowed}/index.html` })
			expect(opened.page).toMatchObject({ title: 'Fixture index', tab: 't1' })
			const snapshot = (await host.observe({ action: 'snapshot' })).snapshot
			const ref = refOf(snapshot?.text ?? '', /link "Order form"/)
			const clicked = await host.act({
				action: 'click',
				ref,
				origin: server.allowed,
				snapshot: true,
			})
			expect(clicked.snapshot?.page.url).toBe(`${server.allowed}/form.html`)
			// The tab count did not change: the host used the pane's tab, it did not open one.
			expect((await host.observe({ action: 'tabs', op: 'list' })).tabs).toHaveLength(1)
			expect((await pane.listTabs()).length).toBe(1)
			// The loader id read for page effects goes through a second session on the same tab.
			expect(pane.sent.some((c) => c.endsWith('Page.getFrameTree'))).toBe(true)
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('prefers the pane, and opens its own browser with a note when the pane cannot be driven', async () => {
		const down = {
			id: 'pane',
			open: async () => {
				throw new Error('There is no Browser pane to open a tab in.')
			},
		}
		const host = new PlaywrightBrowserHost({
			preferredProvider: down,
			engine: 'local',
			headless: 'always',
			sites: { [server.allowed]: 'act', '*': 'ask' },
		})
		try {
			expect(host.prefersPane).toBe(true)
			expect(host.where).toBe('unknown')
			const opened = await host.observe({
				action: 'navigate',
				url: `${server.allowed}/index.html`,
			})
			expect(opened.page?.title).toBe('Fixture index')
			expect(opened.message).toContain('The Browser pane could not be used')
			expect(opened.message).toContain('There is no Browser pane to open a tab in.')
			expect(host.where).toBe('own')
		} finally {
			await host.dispose()
		}
	})

	it('reports the pane as where it runs when the preferred provider connects', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = new PlaywrightBrowserHost({
			preferredProvider: createPaneProvider(pane),
			sites: { [server.allowed]: 'act', '*': 'ask' },
		})
		try {
			await host.observe({
				action: 'navigate',
				url: `${server.allowed}/index.html`,
			})
			expect(host.where).toBe('pane')
			const login = await host.observe({
				action: 'navigate',
				url: `${server.allowed}/login.html`,
			})
			expect(login.message).not.toContain('namzu browser login')
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('does not name a terminal login command for a pane tab', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = new PlaywrightBrowserHost({
			provider: createPaneProvider(pane),
			sites: { [server.allowed]: 'act', '*': 'ask' },
		})
		try {
			const first = await host.observe({ action: 'navigate', url: `${server.allowed}/login.html` })
			expect(first.message).toContain('You cannot type one')
			expect(first.message).not.toContain('namzu browser login')
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('asks the pane for a tab when it has none', async () => {
		const pane = await startChromiumPane({ initialTabs: 0 })
		const host = hostOn(pane)
		try {
			expect(await pane.listTabs()).toHaveLength(0)
			const opened = await host.observe({ action: 'navigate', url: `${server.allowed}/index.html` })
			expect(opened.page?.title).toBe('Fixture index')
			expect(await pane.listTabs()).toHaveLength(1)
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('says so when the pane does not let the agent open a tab', async () => {
		const pane = await startChromiumPane({ initialTabs: 0, allowOpenTab: false })
		const host = hostOn(pane)
		try {
			await expect(
				host.observe({ action: 'navigate', url: `${server.allowed}/index.html` }),
			).rejects.toThrow(/does not let the agent open tabs/)
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('screens a request over the pane channel: a site nobody asked for is refused before it is sent', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = hostOn(pane)
		try {
			await host.observe({ action: 'navigate', url: `${server.allowed}/index.html` })
			// Request interception reached the page: it is what the screening runs on.
			expect(pane.sent.some((c) => c.endsWith('Fetch.enable'))).toBe(true)
			const link = refOf(
				(await host.observe({ action: 'snapshot' })).snapshot?.text ?? '',
				/link "Leave by redirect"/,
			)
			const before = server.requests.filter((r) =>
				r.startsWith(`GET localhost:${server.port}`),
			).length
			const result = await host.act({ action: 'click', ref: link, origin: server.allowed })
			// The redirect lands on another site; the tab is cleared and the model is told.
			expect(result.message).toMatch(/cleared to about:blank|blocked before it was sent/)
			expect(host.describeRef('e1')).toBeUndefined()
			const after = server.requests.filter((r) =>
				r.startsWith(`GET localhost:${server.port}`),
			).length
			expect(after).toBeLessThanOrEqual(before + 1)
			const url = (await host.observe({ action: 'snapshot' })).snapshot?.page.url
			expect(url).toBe('about:blank')
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('holds a popup until the screening is in place, and sees it as a tab of its own', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = hostOn(pane)
		try {
			await host.observe({ action: 'navigate', url: `${server.allowed}/popup.html` })
			const text = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
			const same = await host.act({
				action: 'click',
				ref: refOf(text, /button "Open same-site window"/),
				origin: server.allowed,
			})
			expect(same.message).toMatch(/opened a new tab, t2/)
			const before = server.requests.filter((r) =>
				r.startsWith(`GET localhost:${server.port}`),
			).length
			const other = await host.act({
				action: 'click',
				ref: refOf(text, /link "Open other site"/),
				origin: server.allowed,
			})
			expect(other.message).toMatch(/blocked before it was sent/)
			expect(
				server.requests.filter((r) => r.startsWith(`GET localhost:${server.port}`)).length,
			).toBe(before)
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('answers a page dialog through the dialog flow', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = hostOn(pane)
		try {
			await host.observe({ action: 'navigate', url: `${server.allowed}/dialog.html` })
			const text = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
			const clicked = await host.act({
				action: 'click',
				ref: refOf(text, /button/),
				origin: server.allowed,
			})
			expect(clicked.message).toMatch(/dialog is open/)
			const answered = await host.act({
				action: 'dialog',
				accept: false,
				origin: server.allowed,
			})
			expect(answered.message ?? '').not.toMatch(/dialog is open/)
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('forgets a tab the person closed, and keeps working in the next one', async () => {
		const pane = await startChromiumPane({ initialTabs: 2 })
		const host = hostOn(pane)
		try {
			const first = await host.observe({ action: 'tabs', op: 'list' })
			expect(first.tabs).toHaveLength(2)
			const gone = (await pane.listTabs())[0]
			if (!gone) throw new Error('no tab')
			// The host started on the first tab; close the other one, the way a person would.
			const other = (await pane.listTabs()).find((t) => t.tabId !== gone.tabId)
			if (!other) throw new Error('no second tab')
			await pane.removeTab(other.tabId)
			await expect
				.poll(async () => ((await host.observe({ action: 'tabs', op: 'list' })).tabs ?? []).length)
				.toBe(1)
			const result = await host.observe({ action: 'navigate', url: `${server.allowed}/index.html` })
			expect(result.page?.title).toBe('Fixture index')
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('never sends the pane a command that reaches the profile', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = hostOn(pane)
		try {
			await host.observe({ action: 'navigate', url: `${server.allowed}/form.html` })
			const text = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
			await host.act({
				action: 'type',
				ref: refOf(text, /textbox "Full name"/),
				text: 'Ada',
				origin: server.allowed,
			})
			await host.observe({ action: 'screenshot' })
			const methods = new Set(pane.sent.map((c) => c.split(' ')[1]))
			for (const method of methods) {
				expect(method, 'a method that reaches outside the page').not.toMatch(
					/^(Storage|IndexedDB|Debugger|Tracing|SystemInfo)\.|Cookies?$|^Network\.clearBrowser|setDownloadBehavior/,
				)
			}
		} finally {
			await host.dispose()
			await pane.shutdown()
		}
	})

	it('lets go of the tabs on dispose and leaves them open', async () => {
		const pane = await startChromiumPane({ initialTabs: 1 })
		const host = hostOn(pane)
		try {
			await host.observe({ action: 'navigate', url: `${server.allowed}/index.html` })
			await host.dispose()
			expect(host.running).toBe(false)
			expect(await pane.listTabs()).toHaveLength(1)
			// The page is still there and still answers.
			const [tab] = await pane.listTabs()
			const title = (await pane.cdp(tab?.tabId ?? '', 'Runtime.evaluate', {
				expression: 'document.title',
			})) as { result: { value: string } }
			expect(title.result.value).toBe('Fixture index')
		} finally {
			await pane.shutdown()
		}
	})
})
