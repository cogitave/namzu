// Re-run: start the desktop dev server (pnpm --filter @namzu/desktop dev), then
//   node research/transcript-polish-20261007/capture.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = join(dirname(fileURLToPath(import.meta.url)), 'artifacts')
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/preview'
const check = (name, ok, detail = '') => console.log(ok ? 'PASS' : 'FAIL', name, detail)
const browser = await chromium.launch()
async function open(width, height, colorScheme) {
	const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, timezoneId: 'UTC', locale: 'en-GB' })
	const page = await ctx.newPage()
	await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), colorScheme)
	await page.goto(url)
	await page.locator('.normal-transcript').waitFor()
	await page.waitForTimeout(800)
	return page
}
async function fit(page) {
	await page.evaluate(() => {
		for (const node of document.querySelectorAll('.normal-transcript'))
			for (let p = node.parentElement; p; p = p.parentElement)
				if (p.scrollHeight > p.clientHeight + 4) p.scrollTop = 0
	})
}

let page = await open(1440, 900, 'dark')
await page.screenshot({ path: join(out, '01-bottom-dark-wide.png') })
await fit(page)
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, '00-top-dark-wide.png') })
const seps = await page.$$eval('.transcript-date-separator', (n) => n.map((x) => x.textContent))
check('three date separators (first, new day, 6h gap)', seps.length === 3, JSON.stringify(seps))
const cards = await page.$$eval('[data-turn-changes]', (n) => n.map((x) => x.textContent.replace(/\s+/g, ' ')))
check('two edit cards', cards.length === 2, JSON.stringify(cards))
const tags = await page.$$eval('.attachment-cards', (n) => n.map((x) => x.querySelectorAll('li').length))
check('attachment card lists', tags.length >= 3, JSON.stringify(tags))
const noBubble = await page.$$eval('[data-message-role="user"]', (n) =>
	n.filter((x) => x.querySelector('.attachment-cards') && !x.querySelector('.message-text')).length)
check('attachment-only message has no bubble', noBubble === 1, String(noBubble))
const pend = await page.$eval('[data-attachment-state="pending"] .attachment-card-box', (n) => { const r = n.getBoundingClientRect(); return [r.width, r.height] })
const loaded = await page.$eval('.attachment-card:not([data-attachment-state]) .attachment-card-box', (n) => { const r = n.getBoundingClientRect(); return [r.width, r.height] })
check('pending box equals loaded box (no layout jump)', pend[0] === loaded[0] && pend[1] === loaded[1], `${pend} vs ${loaded}`)
const worked = await page.$$eval('.activity-trigger', (n) => n.map((x) => x.textContent))
console.log('activity labels', JSON.stringify(worked))

// Multi-file card: expand, then open one file
await page.locator('[data-turn-changes="2"] .turn-changes-toggle').scrollIntoViewIfNeeded()
await page.locator('[data-turn-changes="2"] .turn-changes-toggle').click()
await page.waitForTimeout(300)
await page.locator('[data-turn-changes="2"]').scrollIntoViewIfNeeded()
await page.screenshot({ path: join(out, '02-multi-expanded-dark-wide.png') })
await page.locator('[data-turn-changes="2"] .turn-changes-file').nth(1).click()
await page.locator('[data-changes-filter="reply"]').waitFor()
await page.waitForTimeout(1200)
await page.screenshot({ path: join(out, '03-filtered-drawer-dark-wide.png') })
const scopeLabel = await page.locator('.changes-scope').innerText()
check('review opens on the Last reply scope', /Last reply/.test(scopeLabel), scopeLabel)
const treeRows = await page.locator('.changes-tree-row[data-status]').count()
check('the reply\'s files are all listed, not just the clicked one', treeRows >= 2, String(treeRows))
await page.locator('.changes-scope').click()
await page.getByRole('menuitemradio', { name: 'This conversation' }).click()
await page.waitForTimeout(800)
check('scope switches to This conversation', /This conversation/.test(await page.locator('.changes-scope').innerText()))
await page.screenshot({ path: join(out, '04-all-drawer-dark-wide.png') })
await page.close()

page = await open(430, 900, 'light')
await page.screenshot({ path: join(out, '05-bottom-light-narrow.png') })
await fit(page)
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, '04b-top-light-narrow.png') })
await page.locator('[data-turn-changes="1"]').scrollIntoViewIfNeeded()
await page.screenshot({ path: join(out, '06-single-card-light-narrow.png') })
await page.locator('[data-turn-changes="2"]').scrollIntoViewIfNeeded()
await page.screenshot({ path: join(out, '07-multi-card-light-narrow.png') })
const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
check('no horizontal page scroll at 430px', !overflow)
await page.locator('[data-attachment-state="pending"]').scrollIntoViewIfNeeded()
await page.screenshot({ path: join(out, '08-pending-light-narrow.png') })
await browser.close()
