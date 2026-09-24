import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type BrowserResult,
	type ToolContext,
	type ToolDefinition,
	ToolManager,
	browserHostErrorOf,
	createBrowserTools,
	toolset,
} from '@namzu/sdk'
import { chromium } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LocalBrowserPlan } from '../../detect.js'
import { ProfileBusyError } from '../../errors.js'
import { PlaywrightBrowserHost } from '../../host.js'
import { countCredentialFields } from '../../page-scripts.js'
import { locateRef } from '../../snapshot.js'
import { FIXTURE_EXPECTATIONS } from '../fixture-signals.js'
import { type FixtureServer, startFixtureServer } from './fixture-server.js'

/**
 * Against a real Chromium and a local fixture server. Opt in with
 * NAMZU_BROWSER_E2E=1; the browser build playwright-core expects must be in
 * the Playwright cache (nothing is downloaded). NAMZU_BROWSER_E2E_HEADED=1
 * with a display runs the headed smoke test too.
 */
const E2E = process.env.NAMZU_BROWSER_E2E === '1'
const HEADED = E2E && process.env.NAMZU_BROWSER_E2E_HEADED === '1'

const plan = (headless: boolean): LocalBrowserPlan => ({
	engine: 'local',
	platform: 'linux',
	browser: 'chromium',
	headless,
	display: !headless,
	warnings: [],
})

function context(workingDirectory: string): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

async function refusal(run: Promise<unknown>) {
	try {
		await run
	} catch (error) {
		return error as Record<string, unknown>
	}
	throw new Error('expected the call to be refused')
}

/** The ref of the first snapshot line matching `pattern`. */
function refOf(text: string, pattern: RegExp): string {
	const line = text.split('\n').find((l) => pattern.test(l))
	const ref = line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : undefined
	if (!ref) throw new Error(`no ref for ${pattern} in:\n${text}`)
	return ref
}

describe.skipIf(!E2E)('PlaywrightBrowserHost against a local site', { timeout: 30_000 }, () => {
	let server: FixtureServer
	let home: string
	let work: string
	let host: PlaywrightBrowserHost

	const snap = async () => {
		const result = await host.observe({ action: 'snapshot' })
		if (!result.snapshot) throw new Error('no snapshot')
		return result.snapshot
	}
	const origin = () => server.allowed

	beforeAll(async () => {
		server = await startFixtureServer()
		home = mkdtempSync(join(tmpdir(), 'namzu-browser-e2e-'))
		work = mkdtempSync(join(tmpdir(), 'namzu-browser-e2e-work-'))
		host = new PlaywrightBrowserHost({
			home,
			plan: plan(true),
			profile: 'e2e',
			sessionId: 'e2e',
			sites: { [server.allowed]: 'act', '*': 'ask' },
		})
	})

	afterAll(async () => {
		await host?.dispose()
		await server?.close()
		rmSync(home, { recursive: true, force: true })
		rmSync(work, { recursive: true, force: true })
	})

	it('does not launch until the first call, then holds a lease on the profile', async () => {
		expect(host.running).toBe(false)
		expect(host.capabilities.engine).toBe('local-chromium')
		await host.observe({ action: 'navigate', url: `${origin()}/index.html` })
		expect(host.running).toBe(true)
		expect(readdirSync(join(home, 'browser', 'leases', 'e2e'))).toEqual([`${process.pid}-e2e.json`])
	})

	it('contract: ai-mode snapshot refs resolve through aria-ref (fails if an upgrade changes either)', async () => {
		const snapshot = await snap()
		expect(snapshot.page).toMatchObject({ origin: origin(), title: 'Fixture index', tab: 't1' })
		expect(snapshot.text).toMatch(/- link "Order form" \[ref=e\d+\]/)
		const ref = refOf(snapshot.text, /link "Order form"/)
		expect(host.describeRef(ref)).toEqual({ role: 'link', name: 'Order form' })
		// The resolution half, directly: a fresh page, Playwright's own call.
		const browser = await chromium.launch({ headless: true })
		try {
			const page = await browser.newPage()
			await page.setContent('<main><button>One</button><a href="#x">Two</a></main>')
			const text = await page.ariaSnapshot({ mode: 'ai' })
			const buttonRef = refOf(text, /button "One"/)
			expect(await locateRef(page, buttonRef).textContent()).toBe('One')
			expect(await locateRef(page, 'e999').count()).toBe(0)
		} finally {
			await browser.close()
		}
	})

	it('clicks a link by ref and lands on the new page', async () => {
		const ref = refOf((await snap()).text, /link "Order form"/)
		const result = await host.act({ action: 'click', ref, origin: origin(), snapshot: true })
		expect(result.snapshot?.page.url).toBe(`${origin()}/form.html`)
		expect(result.snapshot?.text).toMatch(/button "Place order"/)
	})

	it('fills a form and submits it', async () => {
		const text = (await snap()).text
		const result = await host.act({
			action: 'fill_form',
			origin: origin(),
			fields: [
				{ ref: refOf(text, /textbox "Full name"/), value: 'Ada Lovelace' },
				{ ref: refOf(text, /spinbutton "Quantity"/), value: '3' },
				{ ref: refOf(text, /combobox "Colour"/), value: 'Green' },
				{ ref: refOf(text, /checkbox "Gift wrap"/), value: 'true' },
				{ ref: refOf(text, /textbox "Notes"/), value: 'leave at door' },
			],
		})
		expect(result.page?.url).toBe(`${origin()}/form.html`)
		const submitted = await host.act({
			action: 'click',
			ref: refOf(text, /button "Place order"/),
			origin: origin(),
			snapshot: true,
		})
		expect(submitted.snapshot?.page.title).toBe('Order received')
		for (const line of [
			'name=Ada Lovelace',
			'qty=3',
			'colour=g',
			'gift=yes',
			'notes=leave at door',
		]) {
			expect(submitted.snapshot?.text).toContain(line)
		}
	})

	it('goes back and forward', async () => {
		const back = await host.observe({ action: 'back' })
		expect(back.page?.url).toBe(`${origin()}/form.html`)
		const forward = await host.observe({ action: 'forward' })
		expect(forward.page?.url).toMatch(/\/form-result\?/)
	})

	it('refuses a stale ref and an origin that is not the live page', async () => {
		await host.observe({ action: 'navigate', url: `${origin()}/form.html` })
		const nameRef = refOf((await snap()).text, /textbox "Full name"/)
		await host.observe({ action: 'navigate', url: `${origin()}/index.html` })
		await snap()
		const stale = await refusal(
			host.act({ action: 'type', ref: nameRef, text: 'x', origin: origin() }),
		)
		expect(stale.code).toBe('browser_stale_ref')
		const unknown = await refusal(host.act({ action: 'click', ref: 'e999', origin: origin() }))
		expect(unknown.code).toBe('browser_stale_ref')
		const moved = await refusal(host.act({ action: 'click', ref: nameRef, origin: server.other }))
		expect(moved).toMatchObject({ code: 'browser_origin_mismatch', actual: origin() })
		expect(browserHostErrorOf(moved)).toBeDefined()
	})

	it('reads the same credential signals off the fixtures as the unit table', async () => {
		const browser = await chromium.launch({ headless: true })
		try {
			const page = await browser.newPage()
			for (const [name, expected] of Object.entries(FIXTURE_EXPECTATIONS)) {
				if (!expected.e2e) continue
				await page.goto(`${origin()}/${name}`)
				expect(await page.title(), name).toBe(expected.title)
				expect(await page.evaluate(countCredentialFields), name).toEqual({
					passwordFields: expected.passwordFields,
					oneTimeCodeFields: expected.oneTimeCodeFields,
				})
			}
		} finally {
			await browser.close()
		}
	})

	it('stops on a sign-in page with the handoff data, and never types into its password box', async () => {
		const stopped = await refusal(
			host.observe({ action: 'navigate', url: `${origin()}/login.html` }),
		)
		expect(stopped).toMatchObject({
			code: 'browser_human_required',
			reason: 'sign-in',
			origin: origin(),
			profile: 'e2e',
			loginCommand: `namzu browser login e2e ${origin()}/login.html`,
		})
		const text = (await snap()).text
		const typed = await refusal(
			host.act({
				action: 'type',
				ref: refOf(text, /textbox "Password"/),
				text: 'hunter2',
				origin: origin(),
			}),
		)
		expect(typed).toMatchObject({ code: 'browser_human_required', reason: 'credential-field' })
		const filled = await refusal(
			host.act({
				action: 'fill_form',
				origin: origin(),
				fields: [
					{ ref: refOf(text, /textbox "Email"/), value: 'a@b.c' },
					{ ref: refOf(text, /textbox "Password"/), value: 'hunter2' },
				],
			}),
		)
		expect(filled).toMatchObject({ code: 'browser_human_required', reason: 'credential-field' })
		// The refusal came before anything was typed: the email box is still empty.
		expect(text).not.toContain('a@b.c')
		expect((await snap()).text).not.toContain('a@b.c')
	})

	it('never shows a password or one-time code the page already holds', async () => {
		await refusal(host.observe({ action: 'navigate', url: `${origin()}/autofill.html` }))
		const text = (await snap()).text
		expect(text).toContain('ada@example.com')
		expect(text).not.toContain('hunter2secret')
		expect(text).not.toContain('424242')
		expect(text).toContain('[value hidden: password or one-time code]')
	})

	it('reports the handoff through the SDK tool as handoff data', async () => {
		const [browser, act] = createBrowserTools(host)
		const registry = new ToolManager({
			toolsets: [toolset('test', [browser as ToolDefinition, act as ToolDefinition])],
			messages: () => [],
		})
		const result = await registry.execute(
			'browser',
			{ action: 'navigate', url: `${origin()}/otp.html` },
			context(work),
		)
		expect(result.success).toBe(false)
		expect(result.data).toMatchObject({
			code: 'browser_human_required',
			handoff: {
				kind: 'human-required',
				reason: 'two-factor',
				detail: { origin: origin(), profile: 'e2e' },
			},
		})
	})

	it('stops on a bot wall and an HTTP credential prompt', async () => {
		const wall = await refusal(
			host.observe({ action: 'navigate', url: `${origin()}/challenge.html` }),
		)
		expect(wall).toMatchObject({ code: 'browser_human_required', reason: 'bot-block' })
		const basic = await refusal(host.observe({ action: 'navigate', url: `${origin()}/basic` }))
		expect(basic).toMatchObject({ code: 'browser_human_required', reason: 'http-auth' })
	})

	it('clears a redirect to a site nobody asked for', async () => {
		await host.observe({ action: 'navigate', url: `${origin()}/index.html` })
		const ref = refOf((await snap()).text, /link "Leave by redirect"/)
		const result = await host.act({ action: 'click', ref, origin: origin() })
		expect(result.page?.url).toBe('about:blank')
		expect(result.message).toContain(server.other)
		expect(result.message).toMatch(/cleared to about:blank|blocked before it was sent/)
	})

	it('blocks a script navigation to another site before the request is sent', async () => {
		await host.observe({ action: 'navigate', url: `${origin()}/index.html` })
		const before = server.requests.filter((r) =>
			r.startsWith(`GET localhost:${server.port}/index.html`),
		).length
		const ref = refOf((await snap()).text, /button "Leave by script"/)
		const result = await host.act({ action: 'click', ref, origin: origin() })
		expect(result.message).toMatch(/blocked before it was sent/)
		expect(result.page?.origin).toBe(origin())
		const after = server.requests.filter((r) =>
			r.startsWith(`GET localhost:${server.port}/index.html`),
		).length
		expect(after).toBe(before)
	})

	it('opens a site the caller asked for, even at ask', async () => {
		const result = await host.observe({ action: 'navigate', url: `${server.other}/index.html` })
		expect(result.page?.origin).toBe(server.other)
		// It may be read; acting there is for the gate to review (ask), so the host lets it through.
		const ref = refOf((await snap()).text, /link "Order form"/)
		const clicked = await host.act({ action: 'click', ref, origin: server.other })
		expect(clicked.page?.url).toBe(`${server.other}/form.html`)
	})

	it('makes popups owned tabs, and blocks one heading for an unasked site', async () => {
		const fresh = new PlaywrightBrowserHost({
			home,
			plan: plan(true),
			profile: 'popups',
			sites: { [server.allowed]: 'act', '*': 'ask' },
		})
		try {
			await fresh.observe({ action: 'navigate', url: `${origin()}/popup.html` })
			const text = (await fresh.observe({ action: 'snapshot' })).snapshot?.text ?? ''
			const opened = await fresh.act({
				action: 'click',
				ref: refOf(text, /button "Open same-site window"/),
				origin: origin(),
			})
			expect(opened.message).toMatch(/opened a new tab, t2/)
			const tabs = (await fresh.observe({ action: 'tabs', op: 'list' })).tabs ?? []
			expect(tabs.map((t) => [t.tab, t.active])).toEqual([
				['t1', true],
				['t2', false],
			])
			await expect
				.poll(async () => {
					const list = (await fresh.observe({ action: 'tabs', op: 'list' })).tabs ?? []
					return list.find((t) => t.tab === 't2')?.url
				})
				.toBe(`${origin()}/index.html`)

			const before = server.requests.filter((r) =>
				r.startsWith(`GET localhost:${server.port}`),
			).length
			const other = await fresh.act({
				action: 'click',
				ref: refOf(text, /link "Open other site"/),
				origin: origin(),
			})
			// The popup's first request is stopped before its tab exists, so no tab opens.
			expect(other.message).toMatch(/blocked before it was sent/)
			expect(other.message).toContain(server.other)
			const after = server.requests.filter((r) =>
				r.startsWith(`GET localhost:${server.port}`),
			).length
			expect(after).toBe(before)

			const selected = await fresh.observe({ action: 'tabs', op: 'select', tab: 't2' })
			expect(selected.page?.tab).toBe('t2')
			const closed = await fresh.observe({ action: 'tabs', op: 'close', tab: 't2' })
			expect(closed.tabs?.map((t) => t.tab)).toEqual(['t1'])
		} finally {
			await fresh.dispose()
		}
	})

	it('surfaces a dialog, holds other actions, and answers it', async () => {
		await host.observe({ action: 'navigate', url: `${origin()}/dialog.html` })
		const text = (await snap()).text
		const clicked = await host.act({
			action: 'click',
			ref: refOf(text, /button "Delete"/),
			origin: origin(),
		})
		expect(clicked.message).toMatch(/confirm dialog is open/)
		const shown = await snap()
		expect(shown.text).toContain('- dialog (confirm) "Delete everything?"')
		await expect(
			host.act({ action: 'click', ref: refOf(text, /button "Delete"/), origin: origin() }),
		).rejects.toThrow(/dialog is open/)
		const answered = await host.act({
			action: 'dialog',
			accept: true,
			origin: origin(),
			snapshot: true,
		})
		expect(answered.message).toMatch(/accepted/)
		expect(answered.snapshot?.text).toContain('confirmed')
	})

	it('uploads a file into a file input', async () => {
		const file = join(work, 'invoice.txt')
		writeFileSync(file, 'hello')
		await host.observe({ action: 'navigate', url: `${origin()}/upload.html` })
		const text = (await snap()).text
		const ref = refOf(text, /button "Attachment"/)
		const result = await host.act({
			action: 'upload',
			ref,
			path: file,
			origin: origin(),
			snapshot: true,
		})
		expect(result.snapshot?.text).toContain('picked invoice.txt')
	})

	it('cancels a download and says so', async () => {
		await host.observe({ action: 'navigate', url: `${origin()}/download.html` })
		const ref = refOf((await snap()).text, /link "Get the report"/)
		const result = await host.act({ action: 'click', ref, origin: origin() })
		expect(result.message).toContain('A download of "report.pdf" was cancelled')
		expect(readdirSync(work)).not.toContain('report.pdf')
	})

	it('leaves hidden prompt-injection text out of the snapshot', async () => {
		await host.observe({ action: 'navigate', url: `${origin()}/injection.html` })
		const text = (await snap()).text
		expect(text).toContain('Revenue grew four percent.')
		expect(text).toContain('Costs were flat.')
		expect(text).not.toContain('IGNORE PREVIOUS INSTRUCTIONS')
		expect(text).not.toContain('hidden link')
	})

	it('pages a long snapshot by cursor', async () => {
		const small = new PlaywrightBrowserHost({
			home,
			plan: plan(true),
			profile: 'paging',
			snapshotMaxChars: 120,
			sites: { [server.allowed]: 'read' },
		})
		try {
			await small.observe({ action: 'navigate', url: `${origin()}/form.html` })
			const first = (await small.observe({ action: 'snapshot' })).snapshot
			expect(first?.text.length).toBeLessThanOrEqual(120)
			expect(first?.nextCursor).toBeDefined()
			const second = (
				await small.observe({ action: 'snapshot', cursor: first?.nextCursor as string })
			).snapshot
			expect(second?.text).not.toBe(first?.text)
			// read: navigate and observe, never act.
			const denied = await refusal(small.act({ action: 'press', key: 'Tab', origin: origin() }))
			expect(denied.code).toBe('browser_site_denied')
			const screenshot: BrowserResult = await small.observe({ action: 'screenshot' })
			expect(screenshot.screenshot?.mimeType).toBe('image/png')
			expect(screenshot.screenshot?.width).toBeGreaterThan(0)
		} finally {
			await small.dispose()
		}
	})

	it('refuses a denied site before loading it', async () => {
		const strict = new PlaywrightBrowserHost({
			home,
			plan: plan(true),
			profile: 'strict',
			sites: { [server.other]: 'deny', '*': 'act' },
		})
		try {
			const denied = await refusal(
				strict.observe({ action: 'navigate', url: `${server.other}/index.html` }),
			)
			expect(denied.code).toBe('browser_site_denied')
		} finally {
			await strict.dispose()
		}
	})

	it('refuses a second browser on a profile in use', async () => {
		const second = new PlaywrightBrowserHost({
			home,
			plan: plan(true),
			profile: 'e2e',
			sessionId: 'other',
		})
		await expect(second.observe({ action: 'snapshot' })).rejects.toBeInstanceOf(ProfileBusyError)
		expect(second.running).toBe(false)
	})

	it('closes the browser and drops the lease on dispose', async () => {
		await host.dispose()
		expect(host.running).toBe(false)
		expect(readdirSync(join(home, 'browser', 'leases', 'e2e'))).toEqual([])
	})
})

describe.skipIf(!HEADED)('PlaywrightBrowserHost headed', { timeout: 60_000 }, () => {
	it('opens a visible window, reads and clicks', async () => {
		const server = await startFixtureServer()
		const home = mkdtempSync(join(tmpdir(), 'namzu-browser-headed-'))
		const host = new PlaywrightBrowserHost({
			home,
			plan: plan(false),
			profile: 'headed',
			sites: { [server.allowed]: 'act' },
		})
		try {
			expect(host.capabilities.headless).toBe(false)
			await host.observe({ action: 'navigate', url: `${server.allowed}/index.html` })
			const text = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
			const clicked = await host.act({
				action: 'click',
				ref: refOf(text, /link "Order form"/),
				origin: server.allowed,
			})
			expect(clicked.page?.url).toBe(`${server.allowed}/form.html`)
		} finally {
			await host.dispose()
			await server.close()
			rmSync(home, { recursive: true, force: true })
		}
	})
})
