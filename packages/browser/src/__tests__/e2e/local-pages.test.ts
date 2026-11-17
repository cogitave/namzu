import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type ToolContext,
	type ToolDefinition,
	ToolManager,
	closeBrowserLocalPages,
	createBrowserTools,
	toolset,
} from '@namzu/sdk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LocalBrowserPlan } from '../../detect.js'
import { PlaywrightBrowserHost } from '../../host.js'

/**
 * A page the agent wrote, opened in a real Chromium through the browser tool.
 * Opt in with NAMZU_BROWSER_E2E=1, like the other end-to-end suites.
 */
const E2E = process.env.NAMZU_BROWSER_E2E === '1'

const plan: LocalBrowserPlan = {
	engine: 'local',
	platform: 'linux',
	browser: 'chromium',
	headless: true,
	display: false,
	warnings: [],
}

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

describe.skipIf(!E2E)('a local page in a real browser', { timeout: 60_000 }, () => {
	let home: string
	let work: string
	let outside: string
	let host: PlaywrightBrowserHost
	let manager: ToolManager

	beforeAll(() => {
		home = mkdtempSync(join(tmpdir(), 'namzu-local-e2e-home-'))
		const base = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-local-e2e-')))
		work = join(base, 'work')
		outside = join(base, 'outside')
		mkdirSync(join(work, 'site'), { recursive: true })
		mkdirSync(outside)
		writeFileSync(
			join(work, 'site', 'index.html'),
			[
				'<!doctype html><meta name="viewport" content="width=device-width">',
				'<title>Local page</title><link rel="stylesheet" href="style.css">',
				'<h1>Hello local</h1><button id="b" onclick="document.title=\'clicked\'">Press me</button>',
				'<img id="dot" src="dot.png" alt="dot"><p id="css">css pending</p><p id="img">img pending</p>',
				'<p id="leak">not tried</p>',
				'<script>addEventListener("load",()=>{document.getElementById("css").textContent="css:"+getComputedStyle(document.querySelector("h1")).color;document.getElementById("img").textContent="img:"+document.getElementById("dot").naturalWidth})</script>',
				'<script>fetch("../../outside/secret.txt").then(r=>r.text().then(t=>{document.getElementById("leak").textContent=r.status+":"+t}))</script>',
			].join(''),
		)
		writeFileSync(join(work, 'site', 'style.css'), 'h1 { color: rgb(255, 0, 0) }')
		writeFileSync(
			join(work, 'site', 'dot.png'),
			Buffer.from(
				'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
				'base64',
			),
		)
		writeFileSync(join(outside, 'secret.txt'), 'TOPSECRET')
		symlinkSync(join(outside, 'secret.txt'), join(work, 'site', 'link.txt'))
		host = new PlaywrightBrowserHost({ home, plan, profile: 'e2e-local', sessionId: 'e2e-local' })
		const [browser, act] = createBrowserTools(host)
		manager = new ToolManager({
			toolsets: [toolset('e2e', [browser as ToolDefinition, act as ToolDefinition])],
			messages: () => [],
		})
	})

	afterAll(async () => {
		await closeBrowserLocalPages(host)
		await host?.dispose()
		rmSync(home, { recursive: true, force: true })
		rmSync(join(work, '..'), { recursive: true, force: true })
	})

	it('opens the page, loads its stylesheet, reads it, clicks in it and takes a screenshot', async () => {
		const opened = await manager.execute(
			'browser',
			{ action: 'navigate', url: 'site/index.html' },
			context(work),
		)
		expect(opened.success).toBe(true)
		expect(opened.output).toContain('Hello local')
		// Both ran after the page's own load event, so the relative files were fetched.
		const loaded = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
		expect(loaded).toContain('css:rgb(255, 0, 0)')
		expect(loaded).toContain('img:1')
		const page = (await host.observe({ action: 'snapshot' })).snapshot?.page
		expect(page?.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

		const shot = await manager.execute('browser', { action: 'screenshot' }, context(work))
		expect(shot.success).toBe(true)
		const png = (await host.observe({ action: 'screenshot' })).screenshot?.data
		expect(png && png.length > 100).toBe(true)
		expect(Array.from((png as Uint8Array).slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47])

		const text = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
		const ref = /button "Press me" \[ref=([^\]]+)\]/.exec(text)?.[1]
		expect(ref).toBeDefined()
		const clicked = await host.act({
			action: 'click',
			ref: ref as string,
			origin: page?.origin as string,
			snapshot: true,
		})
		expect(clicked.snapshot?.page.title).toBe('clicked')
	})

	it('the page cannot read a file outside the root through the server', async () => {
		await manager.execute('browser', { action: 'navigate', url: 'site/index.html' }, context(work))
		await host.observe({ action: 'wait_for', timeMs: 500 })
		const text = (await host.observe({ action: 'snapshot' })).snapshot?.text ?? ''
		expect(text).not.toContain('TOPSECRET')
		expect(text).toMatch(/not tried|40\d:/)
	})

	it('refuses a file outside the folder and a link out of it, without opening them', async () => {
		for (const url of [join(outside, 'secret.txt'), 'site/link.txt', 'file:///etc/hostname']) {
			const result = await manager.execute('browser', { action: 'navigate', url }, context(work))
			expect(result.success, url).toBe(false)
		}
	})

	it('the server stops with the session', async () => {
		const result = await manager.execute(
			'browser',
			{ action: 'navigate', url: 'site/index.html' },
			context(work),
		)
		expect(result.success).toBe(true)
		const origin = (await host.observe({ action: 'snapshot' })).snapshot?.page.origin as string
		expect((await fetch(`${origin}/x`)).status).toBe(404)
		await closeBrowserLocalPages(host)
		await expect(fetch(`${origin}/x`)).rejects.toThrow()
	})
})
