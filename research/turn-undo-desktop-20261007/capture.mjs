// Re-run: start the desktop dev server (pnpm --filter @namzu/desktop dev), then
//   node research/turn-undo-desktop-20261007/capture.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = dirname(fileURLToPath(import.meta.url))
const base = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/preview'
const check = (name, ok, detail = '') => console.log(ok ? 'PASS' : 'FAIL', name, detail)
const browser = await chromium.launch()
const sizes = [
	['dark', 1440, 900],
	['light', 900, 720],
]
async function open(scheme, width, height, query = '') {
	const ctx = await browser.newContext({
		viewport: { width, height },
		colorScheme: scheme,
		timezoneId: 'UTC',
		locale: 'en-GB',
	})
	const page = await ctx.newPage()
	await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), scheme)
	await page.goto(base + query)
	await page.locator('.normal-transcript').waitFor()
	await page.locator('[data-turn-changes="2"]').scrollIntoViewIfNeeded()
	await page.waitForTimeout(700)
	return page
}
const card = (page, turn) => page.locator(`[data-turn-changes="${turn}"]`)
const dialog = (page) => page.locator('.undo-dialog')

for (const [scheme, width, height] of sizes) {
	const tag = `${scheme}-${width}`
	let page = await open(scheme, width, height)
	const state = (turn) => card(page, turn).getAttribute('data-undo')
	check(`${tag} turn 1 and 2 offer Undo`, (await state(1)) === 'enabled' && (await state(2)) === 'enabled')
	check(`${tag} the reply with no edits has no card`, (await card(page, 3).count()) === 0)
	await page.screenshot({ path: join(out, `${tag}-01-card-enabled.png`) })

	// Esc leaves everything as it was.
	await card(page, 2).locator('[data-undo-state="enabled"]').click()
	await dialog(page).waitFor()
	await page.getByText('Checking the files…').waitFor({ state: 'detached' }).catch(() => {})
	await dialog(page).locator('.undo-row').first().waitFor()
	const focused = await page.evaluate(() => document.activeElement?.textContent?.trim())
	check(`${tag} focus starts on Cancel, not the destructive button`, focused === 'Cancel', String(focused))
	await page.screenshot({ path: join(out, `${tag}-02-dialog-mixed-rows.png`) })
	const rows = await dialog(page).locator('.undo-row').evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-action')))
	check(`${tag} rows mix restore, delete and conflict`, ['restore', 'delete', 'conflict'].every((a) => rows.includes(a)), rows.join(','))
	check(`${tag} shell warning`, (await dialog(page).innerText()).includes('This reply also ran shell commands. Undo cannot reverse what they changed.'))
	check(`${tag} not-covered list`, (await dialog(page).innerText()).includes('Larger than 8 MiB'))
	check(`${tag} conflicts default to Skip`, (await dialog(page).locator(".undo-choices input[type=radio]:checked").evaluateAll((n) => n.map((x) => x.parentElement.innerText))).join() === "Skip")
	const primary = dialog(page).getByRole('button', { name: /^Undo \d+ files?$/ })
	check(`${tag} primary states the count`, (await primary.innerText()) === 'Undo 2 files', await primary.innerText())

	await dialog(page).getByLabel('Restore anyway, keep my copy').first().check()
	check(`${tag} choosing keep-my-copy adds the file`, (await primary.innerText()) === 'Undo 3 files', await primary.innerText())
	await page.screenshot({ path: join(out, `${tag}-03-conflict-keep-copy.png`) })

	await dialog(page).getByLabel(/Also undo later replies/).check()
	await dialog(page).locator('.undo-heading', { hasText: 'From later replies' }).waitFor()
	await page.screenshot({ path: join(out, `${tag}-04-later-replies.png`) })
	await dialog(page).getByLabel(/Also undo later replies/).uncheck()
	await page.waitForTimeout(300)
	await page.keyboard.press('Escape')
	await dialog(page).waitFor({ state: 'detached' })
	check(`${tag} Esc cancels without undoing`, (await state(2)) === 'enabled')

	// Skip the conflicts: the reply is only partly undone, and says how many files it kept.
	await card(page, 2).locator('[data-undo-state="enabled"]').click()
	await dialog(page).locator('.undo-row').first().waitFor()
	await dialog(page).getByRole('button', { name: /^Undo \d+ files?$/ }).click()
	await dialog(page).getByText('Partly undone.').waitFor()
	await page.screenshot({ path: join(out, `${tag}-05-result-partial.png`) })
	await dialog(page).getByRole('button', { name: 'Close' }).click()
	await dialog(page).waitFor({ state: 'detached' })
	await page.waitForTimeout(500)
	check(`${tag} card reads partial from status`, (await state(2)) === 'partial' && (await card(page, 2).innerText()).includes('Partly undone, 2 files kept'))
	await page.screenshot({ path: join(out, `${tag}-06-card-partial.png`) })

	// The partial card reopens the plan for the rest.
	await card(page, 2).locator('[data-undo-state="partial"]').click()
	await dialog(page).locator('.undo-row').first().waitFor()
	await page.screenshot({ path: join(out, `${tag}-07-partial-reopened.png`) })
	await page.keyboard.press('Escape')
	await dialog(page).waitFor({ state: 'detached' })

	// Undo the first reply outright: the chip, dimmed stats.
	await card(page, 1).locator('[data-undo-state="enabled"]').click()
	await dialog(page).locator('.undo-row').first().waitFor()
	await dialog(page).getByRole('button', { name: 'Undo 1 file' }).click()
	await dialog(page).getByText('Undone.').waitFor()
	await dialog(page).getByRole('button', { name: 'Close' }).click()
	await dialog(page).waitFor({ state: 'detached' })
	await page.waitForTimeout(500)
	check(`${tag} undone chip with a time`, /Undone at \d/.test(await card(page, 1).innerText()))
	const dim = await card(page, 1).locator('.turn-changes-totals').evaluate((n) => getComputedStyle(n).opacity)
	check(`${tag} stats are dimmed`, Number(dim) < 1, dim)
	await page.screenshot({ path: join(out, `${tag}-08-card-undone.png`) })
	await page.context().close()

	// A reply that is already partial when the conversation opens (cold status).
	page = await open(scheme, width, height, '?undo=partial')
	check(`${tag} cold partial`, (await card(page, 2).getAttribute('data-undo')) === 'partial')
	await page.context().close()
	page = await open(scheme, width, height, '?undo=undone')
	check(`${tag} cold undone`, (await card(page, 1).getAttribute('data-undo')) === 'undone' && /^.*Undone$/m.test(await card(page, 1).locator('.turn-changes-undone-chip').innerText()))
	await page.context().close()

	// The files moved after the preview: the plan is shown again, never applied silently.
	page = await open(scheme, width, height, '?undo=moved')
	await card(page, 2).locator('[data-undo-state="enabled"]').click()
	await dialog(page).locator('.undo-row').first().waitFor()
	await dialog(page).getByRole('button', { name: /^Undo \d+ files?$/ }).click()
	await dialog(page).getByRole('status').filter({ hasText: 'changed since this preview' }).waitFor()
	check(`${tag} plan-changed refreshes in place`, (await card(page, 2).getAttribute('data-undo')) === 'enabled')
	await page.screenshot({ path: join(out, `${tag}-09-plan-changed.png`) })
	await page.context().close()
}
await browser.close()
