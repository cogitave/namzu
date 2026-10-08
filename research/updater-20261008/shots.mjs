// Drives the design preview (pnpm --filter @namzu/desktop dev:renderer) with a mocked updater state.
//   node research/updater-20261008/shots.mjs [baseUrl]
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

// @playwright/test is not a dependency of this package; take it from the pnpm store.
const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../package.json'))
const { chromium } = require(
	require.resolve('@playwright/test', {
		paths: [join(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.pnpm/@playwright+test@1.63.0/node_modules')],
	}),
)

const out = dirname(fileURLToPath(import.meta.url))
const base = process.argv[2] ?? 'http://127.0.0.1:5173/preview'
const browser = await chromium.launch()
const results = {}
const errors = []

async function open(scheme, update) {
	const context = await browser.newContext({
		viewport: { width: 1100, height: 700 },
		colorScheme: scheme,
		reducedMotion: 'reduce',
	})
	await context.addInitScript((value) => localStorage.setItem('namzu.appearance', value), scheme)
	const page = await context.newPage()
	page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 200)}`)
	})
	await page.goto(`${base}?update=${update}`, { waitUntil: 'networkidle' })
	await page.waitForSelector('.navigation-rail')
	return { page, context }
}

for (const scheme of ['dark', 'light']) {
	// 1. Badge only, then the tooltip.
	{
		const { page, context } = await open(scheme, 'ready')
		const badge = page.getByRole('button', { name: /Update ready\. Restart Namzu to install version 0\.2\.0/ })
		await badge.waitFor()
		results[`${scheme}.badge.count`] = await badge.count()
		const box = await badge.boundingBox()
		const avatar = await page.locator('.rail-profile-avatar').boundingBox()
		results[`${scheme}.badge.aboveAvatar`] = box.y + box.height <= avatar.y
		await badge.hover()
		await page.waitForTimeout(700)
		results[`${scheme}.tooltip`] = (await page.getByText('Update ready — restart to install').count()) > 0
		await page.locator('.navigation-rail').screenshot({ path: join(out, `${scheme}-1-badge.png`) })
		await page.screenshot({ path: join(out, `${scheme}-1-badge-tooltip.png`), clip: { x: 0, y: 380, width: 360, height: 320 } })
		// 2. Click opens the dialog; focus lands on the primary button; role and labels exist.
		await badge.click()
		const dialog = page.getByRole('dialog')
		await dialog.waitFor()
		results[`${scheme}.dialog.name`] = await dialog.getAttribute('aria-labelledby').then(Boolean)
		results[`${scheme}.dialog.described`] = await dialog.getAttribute('aria-describedby').then(Boolean)
		results[`${scheme}.dialog.focus`] = await page.evaluate(() => document.activeElement?.textContent)
		await page.screenshot({ path: join(out, `${scheme}-2-ready-dialog.png`) })
		// 3. Later closes it and keeps the badge.
		await page.getByRole('button', { name: 'Later' }).click()
		await dialog.waitFor({ state: 'detached' })
		results[`${scheme}.later.badgeKept`] = (await badge.count()) === 1
		// 4. Restart now enters installing; Escape does nothing; no buttons; progressbar is indeterminate.
		await badge.click()
		await page.getByRole('button', { name: 'Restart now' }).click()
		await page.getByText('Preparing…').waitFor()
		await page.keyboard.press('Escape')
		await page.waitForTimeout(200)
		results[`${scheme}.installing.stillOpen`] = (await page.getByRole('dialog').count()) === 1
		results[`${scheme}.installing.buttons`] = await page.getByRole('dialog').getByRole('button').count()
		const bar = page.getByRole('progressbar', { name: 'Update progress' })
		results[`${scheme}.installing.valuenow`] = await bar.getAttribute('value')
		results[`${scheme}.installing.live`] = await page.locator('.update-dialog-status').getAttribute('aria-live')
		await page.screenshot({ path: join(out, `${scheme}-3-installing.png`) })
		await context.close()
	}
	// 5. Downloading shows a real percentage and no badge.
	{
		const { page, context } = await open(scheme, 'downloading')
		results[`${scheme}.downloading.badge`] = await page.locator('.rail-update-button').count()
		await page.getByRole('button', { name: 'Profile' }).click()
		await page.getByRole('menuitem', { name: /Downloading update \(42%\)/ }).click()
		const bar = page.getByRole('progressbar', { name: 'Update progress' })
		await bar.waitFor()
		results[`${scheme}.downloading.valuenow`] = await bar.getAttribute('value')
		await page.screenshot({ path: join(out, `${scheme}-4-downloading.png`) })
		await context.close()
	}
	// 6. Waiting for a running reply.
	{
		const { page, context } = await open(scheme, 'waiting')
		await page.getByRole('button', { name: /Update ready/ }).click()
		await page.getByText('Namzu will update when the current reply finishes.').waitFor()
		results[`${scheme}.waiting.reason`] = (await page.getByText('A reply is still running').count()) === 1
		results[`${scheme}.waiting.buttons`] = await page.getByRole('dialog').getByRole('button').allTextContents()
		await page.screenshot({ path: join(out, `${scheme}-5-waiting.png`) })
		await context.close()
	}
}
await browser.close()
results.errors = errors
writeFileSync(join(out, 'results.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
