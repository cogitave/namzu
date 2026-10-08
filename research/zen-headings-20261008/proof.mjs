/** Actual-renderer proof: Zen's free and API-key models sit under separate headings. */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium } = require('@playwright/test')
const out = join(repo, 'research/zen-headings-20261008')
const clip = { x: 660, y: 300, width: 440, height: 420 }
const browser = await chromium.launch()
for (const scheme of ['dark', 'light']) {
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme })
	const page = await ctx.newPage()
	await page.addInitScript((v) => localStorage.setItem('namzu.appearance', v), scheme)
	await page.goto('http://127.0.0.1:5173/preview')
	await page.locator('.model-picker-trigger').first().click()
	await page.locator('.composer-effort-model').click()
	await page.waitForSelector('.model-picker-row')
	await page.locator('.model-provider-tab[aria-label="Sample Zen"]').click()
	await page.getByText('Sample Reasoner').waitFor()
	const titles = () => page.locator('.model-picker-group-title').allTextContents()
	console.log(scheme, 'headings', JSON.stringify(await titles()))
	console.log(scheme, 'radios', await page.locator('[role="radio"]').count())
	await page.screenshot({ path: join(out, `${scheme}-zen.png`), clip })
	// Keyboard: from the first model row, ArrowDown x2 crosses a heading and lands on a row.
	await page.locator('[role="radio"]', { hasText: 'Sample Flash Free' }).focus()
	await page.keyboard.press('ArrowDown')
	console.log(scheme, 'after one ArrowDown from last free row:', await page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
	// Search keeps headings only for groups that still match.
	await page.locator('button[aria-label="Search models"]').click()
	await page.locator('input[type="search"]').fill('reasoner')
	await page.waitForTimeout(300)
	console.log(scheme, 'search reasoner headings', JSON.stringify(await titles()))
	await page.screenshot({ path: join(out, `${scheme}-zen-search.png`), clip })
	await ctx.close()
}
await browser.close()
