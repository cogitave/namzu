/** Actual-renderer proof of the project connecting states in the loopback Vite preview. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium } = require('@playwright/test')
const out = join(repo, 'research/project-connecting-20261008/artifacts')
const base = 'http://127.0.0.1:5173/preview'
const gate = 'Review folder access'
const browser = await chromium.launch()
const report = []
const errors = []

// Samples the page from inside every 50 ms so the gate cannot hide between screenshots.
const watch = (page) =>
	page.addInitScript(() => {
		window.__frames = []
		const t0 = performance.now()
		const id = setInterval(() => {
			const text = document.body.innerText
			window.__frames.push({
				t: Math.round(performance.now() - t0),
				gate: text.includes('Review folder access') || text.includes('Make this your workspace'),
				spinner: !!document.querySelector('.project-connecting-spinner'),
				opening: text.includes('Opening Sample app'),
				ready: !!document.querySelector('.chat-stage'),
				error: text.includes('Couldn’t open this folder'),
			})
		}, 50)
		window.__stop = () => clearInterval(id)
	})

for (const scheme of ['dark', 'light']) {
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme })
	const shoot = async (page, name) => page.screenshot({ path: join(out, `${name}-${scheme}.png`) })
	const open = async (query) => {
		const page = await ctx.newPage()
		page.on('pageerror', (e) => errors.push(String(e)))
		await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), scheme)
		await watch(page)
		await page.goto(`${base}?connect=${query}`)
		return page
	}

	// slow: blank, then spinner, then ready, no gate at any frame.
	{
		const page = await open('slow')
		await page.getByText('Projects', { exact: true }).waitFor()
		const early = await page.evaluate(() => ({
			spinner: !!document.querySelector('.project-connecting-spinner'),
			gate: document.body.innerText.includes('Review folder access'),
			sidebar: !!document.querySelector('aside, nav'),
		}))
		await shoot(page, 'connecting-before-400ms')
		await page.waitForSelector('.project-connecting-spinner')
		await shoot(page, 'connecting-spinner')
		await page.waitForSelector('.chat-stage', { timeout: 8000 })
		await page.waitForTimeout(300)
		await shoot(page, 'ready')
		const frames = await page.evaluate(() => (window.__stop(), window.__frames))
		assert.equal(early.spinner, false, 'no spinner before 400 ms')
		assert.equal(frames.some((f) => f.gate), false, 'gate never appears for a trusted project')
		assert(frames.some((f) => f.spinner) && frames.some((f) => f.ready))
		report.push({ scheme, scenario: 'slow', early, frames: frames.length, gateFrames: 0,
			spinnerFrames: frames.filter((f) => f.spinner).length, firstSpinnerMs: frames.find((f) => f.spinner)?.t,
			firstReadyMs: frames.find((f) => f.ready)?.t })
		await page.close()
	}
	// untrusted: the gate, once ready.
	{
		const page = await open('untrusted')
		await page.getByText(gate).waitFor()
		await shoot(page, 'untrusted-gate')
		report.push({ scheme, scenario: 'untrusted', gate: true })
		await page.close()
	}
	// error: not the gate, one message, Try again.
	{
		const page = await open('error')
		await page.getByText('Couldn’t open this folder').waitFor({ timeout: 8000 })
		await page.waitForTimeout(200)
		const frames = await page.evaluate(() => (window.__stop(), window.__frames))
		assert.equal(frames.some((f) => f.gate), false)
		const text = 'The Namzu runtime did not start. Check that it is installed, then try again.'
		const copies = await page.getByText(text).count()
		assert.equal(copies, 1, 'error text appears once')
		await shoot(page, 'error')
		await page.getByRole('button', { name: 'Try again' }).click()
		await page.waitForTimeout(100)
		const retrying = await page.evaluate(() => document.body.innerText.includes('Couldn’t open'))
		await page.waitForSelector('.project-connecting-spinner')
		await shoot(page, 'error-retrying')
		await page.getByText('Couldn’t open this folder').waitFor({ timeout: 8000 })
		report.push({ scheme, scenario: 'error', copies, errorShownDuringRetry: retrying, gateFrames: 0 })
		await page.close()
	}
	await ctx.close()
}
await browser.close()
assert.deepEqual(errors, [], 'no page errors')
await writeFile(join(out, 'proof.json'), `${JSON.stringify({ pageErrors: errors, report }, null, 2)}\n`)
console.log(JSON.stringify(report, null, 1))
