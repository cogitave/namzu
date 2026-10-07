// Re-run: start the desktop dev server (pnpm --filter @namzu/desktop dev), then
//   node research/diffs-upgrade-20261007/capture.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = join(dirname(fileURLToPath(import.meta.url)), 'artifacts')
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/preview'
const check = (name, ok, detail = '') => console.log(ok ? 'PASS' : 'FAIL', name, detail)
const browser = await chromium.launch()
const errors = []

async function open(scheme) {
	const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, timezoneId: 'UTC', locale: 'en-GB' })
	const page = await ctx.newPage()
	page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
	page.on('pageerror', (e) => errors.push(String(e)))
	await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), scheme)
	await page.goto(url)
	await page.locator('.normal-transcript').waitFor()
	const id = await page.$eval('[data-pane-id]', (n) => n.getAttribute('data-pane-id'))
	await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`namzu.workspace.panel-width:${id}`, '900'])
	await page.reload()
	await page.locator('.normal-transcript').waitFor()
	await page.waitForTimeout(800)
	return page
}
async function openUncommitted(page) {
	await page.locator('[data-turn-changes="2"] .turn-changes-toggle').scrollIntoViewIfNeeded()
	await page.locator('[data-turn-changes="2"] .turn-changes-toggle').click()
	await page.locator('[data-turn-changes="2"] .turn-changes-file').nth(1).click()
	await page.locator('.changes-review').waitFor()
	// The menu can close on a slow first paint, so ask again until the scope reads right.
	for (let attempt = 0; attempt < 5; attempt++) {
		await page.locator('.changes-scope').click()
		await page.waitForTimeout(500)
		await page.getByRole('menuitemradio', { name: 'Uncommitted changes' }).click({ force: true })
		await page.waitForTimeout(900)
		if ((await page.locator('.changes-scope').innerText()).includes('Uncommitted')) return
	}
}
// A click right after the tree paints can be lost, so repeat until the head names the file.
const pick = async (page, text) => {
	for (let attempt = 0; attempt < 5; attempt++) {
		await page.locator('.changes-tree-row', { hasText: text }).click({ timeout: 8000 }).catch(() => {})
		await page.waitForTimeout(1500)
		if ((await page.locator('.changes-diff-path').innerText()).includes(text)) return
	}
	throw new Error(`could not select ${text}`)
}

for (const scheme of ['dark', 'light']) {
	const page = await open(scheme)
	await openUncommitted(page)

	// 1. a normal diff
	await pick(page, 'security-report.md')
	check(`${scheme}: normal diff is rich`, (await page.locator('.diff-code-view').count()) === 1 && (await page.locator('.changes-plain-patch').count()) === 0)
	const hosts = await page.locator('.diff-code-view').evaluate((n) => !!n.shadowRoot?.querySelector('[data-diff]'))
	check(`${scheme}: rich diff rendered rows`, hosts)
	await page.screenshot({ path: join(out, `01-normal-diff-${scheme}.png`) })

	// 2. the gate
	await pick(page, 'rate-table.ts')
	const note = await page.locator('.changes-gate-note').innerText()
	check(`${scheme}: 5,000-line diff is gated`, note.includes('10,000 lines') && (await page.locator('.diff-code-view').count()) === 0, note.replace(/\n/g, ' | '))
	const patch = await page.locator('.changes-plain-patch').innerText()
	check(`${scheme}: plain patch is a unified patch`, patch.startsWith('--- a/src/generated/rate-table.ts\n+++ b/') && patch.includes('@@ -1,'), `${patch.split('\n').length} lines`)
	const font = await page.locator('.changes-plain-patch').evaluate((n) => getComputedStyle(n).fontFamily)
	check(`${scheme}: patch is monospaced`, /mono|Menlo|Consolas|monospace/i.test(font), font)
	await page.getByRole('button', { name: 'Wrap diff lines' }).click()
	const wrapped = await page.locator('.changes-plain-patch').evaluate((n) => [n.hasAttribute('data-wrap'), getComputedStyle(n).whiteSpace, n.scrollWidth <= n.clientWidth + 1])
	check(`${scheme}: wrap toggle soft-wraps the plain patch`, wrapped[0] && wrapped[1] === 'pre-wrap' && wrapped[2], wrapped.join(' '))
	await page.getByRole('button', { name: 'Wrap diff lines' }).click()
	await page.screenshot({ path: join(out, `02-gated-${scheme}.png`) })
	const t0 = Date.now()
	await page.getByRole('button', { name: 'Show full diff anyway' }).click()
	await page.locator('.diff-code-view').waitFor()
	await page.waitForTimeout(2000)
	check(`${scheme}: Show full diff anyway renders the rich view`, (await page.locator('.changes-plain-patch').count()) === 0, `${Date.now() - t0} ms incl. 2 s settle`)
	await page.screenshot({ path: join(out, `03-gate-forced-${scheme}.png`) })
	await pick(page, 'security-report.md')
	await pick(page, 'rate-table.ts')
	console.log('INFO', scheme, 'after choosing the file again the', (await page.locator('.diff-code-view').count()) === 1 ? 'rich view is still on (choice kept for that path)' : 'gate is back')

	// 3. the source view
	await pick(page, 'old-name.ts')
	await page.locator('.changes-diff-head').getByRole('button', { name: 'Open file' }).click()
	await page.locator('.file-source').waitFor()
	await page.waitForTimeout(1500)
	const rendered = await page.locator('.file-source .diff-code-view').evaluate((n) => (n.shadowRoot?.querySelectorAll('[data-line]').length ?? 0))
	check(`${scheme}: source view draws lines`, rendered >= 2, `${rendered} lines`)
	await page.screenshot({ path: join(out, `04-source-view-${scheme}.png`) })
	await page.close()
}
console.log('console errors:', errors.length, JSON.stringify(errors.slice(0, 5)))
await browser.close()
