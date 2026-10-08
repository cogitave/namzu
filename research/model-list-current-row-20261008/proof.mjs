/** Actual-renderer proof: no "Current model" section; the provider in use is dotted on its tab. */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium } = require('@playwright/test')
const out = join(repo, 'research/model-list-current-row-20261008')
const browser = await chromium.launch()
for (const scheme of ['dark', 'light']) {
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme })
	const page = await ctx.newPage()
	await page.addInitScript((v) => localStorage.setItem('namzu.appearance', v), scheme)
	await page.goto('http://127.0.0.1:5173/preview')
	await page.locator('.model-picker-trigger').first().click()
	await page.locator('.composer-effort-model').click()
	await page.waitForSelector('.model-picker-row')
	const tabs = await page.locator('.model-provider-tab').evaluateAll((els) =>
		els.map((e) => [e.getAttribute('aria-label'), e.hasAttribute('data-in-use'), e.hasAttribute('data-active')]),
	)
	console.log(scheme, 'tabs', JSON.stringify(tabs))
	await page.waitForTimeout(600)
	await page.screenshot({ path: join(out, `${scheme}-in-use-provider.png`), clip: { x: 640, y: 420, width: 460, height: 330 } })
	const other = page.locator('.model-provider-tab:not([data-in-use])').first()
	if (await other.count()) {
		await other.click()
		await page.waitForTimeout(400)
		console.log(scheme, 'current-section', await page.locator('.model-picker-current').count(), await page.getByText('Current model').count())
		await page.screenshot({ path: join(out, `${scheme}-other-provider.png`), clip: { x: 640, y: 420, width: 460, height: 330 } })
	}
	await ctx.close()
}
await browser.close()
