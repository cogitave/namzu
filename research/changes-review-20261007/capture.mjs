// Re-run: start the desktop dev server (pnpm --filter @namzu/desktop dev), then
//   node research/changes-review-20261007/capture.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = join(dirname(fileURLToPath(import.meta.url)), 'artifacts')
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/preview'
const check = (name, ok, detail = '') => console.log(ok ? 'PASS' : 'FAIL', name, detail)
const browser = await chromium.launch()
async function open(width, height, colorScheme, panel) {
	const ctx = await browser.newContext({ viewport: { width, height }, colorScheme, timezoneId: 'UTC', locale: 'en-GB' })
	const page = await ctx.newPage()
	await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), colorScheme)
	await page.goto(url)
	await page.locator('.normal-transcript').waitFor()
	if (panel) {
		const id = await page.$eval('[data-pane-id]', (n) => n.getAttribute('data-pane-id'))
		await page.evaluate(([key, value]) => localStorage.setItem(key, value), [`namzu.workspace.panel-width:${id}`, String(panel)])
		await page.reload()
		await page.locator('.normal-transcript').waitFor()
	}
	await page.waitForTimeout(800)
	return page
}
// Opens the drawer from the last reply's card, as a person would.
async function openChanges(page) {
	await page.locator('[data-turn-changes="2"] .turn-changes-toggle').scrollIntoViewIfNeeded()
	await page.locator('[data-turn-changes="2"] .turn-changes-toggle').click()
	await page.locator('[data-turn-changes="2"] .turn-changes-file').nth(1).click()
	await page.locator('.changes-review').waitFor()
	await page.waitForTimeout(1200)
}
async function scope(page, name) {
	await page.locator('.changes-scope').click()
	await page.waitForTimeout(400)
	await page.getByRole('menuitemradio', { name }).click({ force: true })
	await page.waitForTimeout(900)
}

let page = await open(1440, 900, 'dark')
await openChanges(page)
await page.screenshot({ path: join(out, '00-last-reply-stacked-dark-1440.png') })
await page.close()
page = await open(1440, 900, 'dark', 900)
await openChanges(page)
check('opened from a reply shows Last reply', (await page.locator('.changes-scope').innerText()).includes('Last reply'))
await page.screenshot({ path: join(out, '01-last-reply-wide-dark-1440.png') })
check('a clicked card row opens the whole reply', (await page.locator('.changes-tree-row[data-status]').count()) >= 2, String(await page.locator('.changes-tree-row[data-status]').count()))
check('the clicked file is selected', (await page.locator('.changes-tree-row[aria-selected="true"]').count()) === 1)
const cols = await page.$eval('.changes-body', (n) => getComputedStyle(n).gridTemplateColumns)
check('two columns when wide', cols.split(' ').length === 2, cols)
await scope(page, 'This conversation')
await page.screenshot({ path: join(out, '03-conversation-wide-dark-1440.png') })
const rows = await page.locator('.changes-tree-row').allInnerTexts()
check('conversation lists each path once', rows.filter((r) => r.includes('sidebar.css')).length === 1, JSON.stringify(rows))
await scope(page, 'Uncommitted changes')
await page.screenshot({ path: join(out, '04-uncommitted-wide-dark-1440.png') })
const tree = await page.locator('.changes-tree-row').allInnerTexts()
console.log('tree rows', JSON.stringify(tree))
check('deleted file struck through', (await page.locator('[data-status="deleted"] .changes-tree-name').count()) === 1)
check('untracked marked new', tree.some((r) => r.includes('new')))
// Open file reads the path directly, so a tab appears for an uncommitted file.
await page.locator('.changes-tree-row', { hasText: 'design.md' }).click()
const tabsBefore = await page.getByRole('tab').count()
await page.locator('.changes-diff-head').getByRole('button', { name: 'Open file' }).click()
await page.waitForTimeout(800)
check('Open file adds a design.md tab', (await page.getByRole('tab', { name: 'design.md' }).count()) === 1 && (await page.getByRole('tab').count()) > tabsBefore, `${tabsBefore} -> ${await page.getByRole('tab').count()}`)
await page.screenshot({ path: join(out, '04b-open-file-tab-dark-1440.png') })
await page.locator('.changes-tab, [role=tab]', { hasText: 'Changes' }).first().click().catch(() => {})
await page.waitForTimeout(400)
// Returning to the tab remounts the review, so ask for the working tree again.
if (!(await page.locator('.changes-scope').innerText()).includes('Uncommitted')) await scope(page, 'Uncommitted changes')
// keyboard: ] moves to the next file
const before = await page.locator('.changes-diff-path').innerText()
await page.locator('.changes-tree-row[data-active]').focus()
await page.keyboard.press(']')
await page.waitForTimeout(600)
const after = await page.locator('.changes-diff-path').innerText()
check('] selects the next file', before !== after, `${before} -> ${after}`)
await page.screenshot({ path: join(out, '05-next-file-dark-1440.png') })
await page.getByRole('combobox').count()
await page.locator('.changes-filter input').fill('readme')
await page.waitForTimeout(300)
check('filter narrows the tree', (await page.locator('.changes-tree-row').count()) <= 3, String(await page.locator('.changes-tree-row').count()))
await page.screenshot({ path: join(out, '06-filter-dark-1440.png') })
await page.locator('.changes-filter input').fill('')
// binary and renamed
await page.locator('.changes-tree-row', { hasText: 'logo.png' }).click()
await page.waitForTimeout(500)
check('binary shows a message', (await page.locator('.changes-message').innerText()).includes('binary'))
check('binary header carries no +0 -0', (await page.locator('.changes-diff-head .changes-diff-counts').count()) === 0)
await page.screenshot({ path: join(out, '07-binary-dark-1440.png') })
await page.close()

page = await open(900, 720, 'light')
await openChanges(page)
await page.screenshot({ path: join(out, '08-last-reply-light-900.png') })
await scope(page, 'Uncommitted changes')
await page.locator('.changes-files-toggle').click()
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, '09-uncommitted-files-open-light-900.png') })
check('no horizontal page scroll at 900px', !(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)))
await page.close()
page = await open(900, 720, 'light', 640)
await openChanges(page)
await scope(page, 'Uncommitted changes')
await page.screenshot({ path: join(out, '10-uncommitted-wide-light-900.png') })
await browser.close()
