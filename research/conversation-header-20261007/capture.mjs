// Re-run: start the desktop dev server (pnpm --filter @namzu/desktop dev), then
//   node research/conversation-header-20261007/capture.mjs
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = join(dirname(fileURLToPath(import.meta.url)), 'artifacts')
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/preview'
const checks = []
const check = (name, ok, detail = '') => {
	checks.push({ name, ok, detail })
	console.log(ok ? 'PASS' : 'FAIL', name, detail)
}
const browser = await chromium.launch()
// An open submenu makes Playwright treat its parent as covered, so move a real pointer instead.
async function hover(page, name) {
	const box = await page.getByRole('menuitem', { name }).boundingBox()
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
}
async function open(width, height, colorScheme) {
	const ctx = await browser.newContext({
		viewport: { width, height },
		colorScheme,
		permissions: ['clipboard-read', 'clipboard-write'],
	})
	const page = await ctx.newPage()
	// The app reads its own appearance setting before the system colour scheme.
	await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), colorScheme)
	await page.goto(url)
	await page.locator('.conversation-details-trigger').waitFor()
	return page
}

// Dark, wide
let page = await open(1440, 900, 'dark')
await page.getByRole('button', { name: 'Conversation actions' }).click()
await page.getByRole('menu', { name: 'Conversation actions' }).waitFor()
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '01-menu-dark-wide.png') })
const colors = await page.$$eval('.conversation-actions-item', (items) =>
	items.map((item) => getComputedStyle(item).color),
)
check('Archive row is not coloured differently from the other items', new Set(colors).size === 1, colors[0])
await hover(page, /^Fork/)
await page.waitForTimeout(500)
await page.screenshot({ path: join(out, '02-fork-submenu.png') })
await hover(page, /^Copy/)
await page.waitForTimeout(500)
await page.screenshot({ path: join(out, '03-copy-submenu.png') })
await page.keyboard.press('Escape')
await page.keyboard.press('Escape')
await page.waitForTimeout(600)

// Escape, then a quick click on details
for (const wait of [50, 150, 300]) {
	await page.getByRole('button', { name: 'Conversation actions' }).click()
	await page.getByRole('menu', { name: 'Conversation actions' }).waitFor()
	await page.keyboard.press('Escape')
	await page.waitForTimeout(wait)
	await page.locator('.conversation-details-trigger').click()
	const shown = await page.locator('.conversation-details').first().isVisible().catch(() => false)
	check(`details open ${wait} ms after the menu closed`, shown)
	await page.keyboard.press('Escape')
	await page.waitForTimeout(400)
}

// Rename dialog
await page.getByRole('button', { name: 'Conversation actions' }).click()
await page.getByRole('menuitem', { name: /^Rename/ }).click()
await page.getByRole('dialog').waitFor()
await page.screenshot({ path: join(out, '04-rename-dialog.png') })
await page.keyboard.press('Control+A')
await page.keyboard.type('Renamed in the proof')
await page.keyboard.press('Enter')
await page.waitForTimeout(500)

// Details popover
await page.locator('.conversation-details-trigger').click()
await page.locator('.conversation-details').waitFor()
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, '05-details-popover.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(300)

// Pinned sidebar alignment: pin the active conversation with its shortcut
await page.keyboard.press('Control+Alt+KeyP')
await page.waitForTimeout(600)
const rows = await page.$$eval('.sidebar-project-list .conversation-row', (nodes) =>
	nodes.map((node) => ({
		pinned: !!node.querySelector('.conversation-row-pin'),
		x: Math.round(node.querySelector('.conversation-row-title').getBoundingClientRect().left),
	})),
)
const pinned = rows.filter((row) => row.pinned)
const others = rows.filter((row) => !row.pinned)
check(
	'pinned row label starts at the same x as its siblings',
	pinned.length > 0 && others.length > 0 && pinned.every((row) => row.x === others[0].x),
	JSON.stringify(rows),
)
const tabPin = await page.locator('.conversation-tab-pin').count()
check('pinned conversation shows a pin in its tab', tabPin === 1, `${tabPin}`)
await page.screenshot({ path: join(out, '06-pinned-sidebar-dark-wide.png') })

// Side chat keeps the source visible on the left
await page.getByRole('button', { name: 'Conversation actions' }).click()
await page.getByRole('menuitem', { name: /^New side chat/ }).click()
await page.waitForTimeout(1500)
const active = await page.$$eval('.conversation-tab[data-active="true"] .conversation-tab-label', (n) =>
	n.map((node) => node.textContent),
)
check('side chat: each pane has an active tab', active.length >= 2, JSON.stringify(active))
const titleHeads = await page.$$eval('[aria-current="page"], .conversation-header-title', (n) =>
	n.map((node) => node.textContent?.trim()),
)
await page.screenshot({ path: join(out, '07-side-chat.png') })
console.log('active tabs', active, titleHeads)
await page.context().close()

// Light, narrow
page = await open(640, 800, 'light')
await page.getByRole('button', { name: 'Conversation actions' }).click()
await page.getByRole('menu', { name: 'Conversation actions' }).waitFor()
await page.waitForTimeout(400)
await page.screenshot({ path: join(out, '08-menu-light-narrow.png') })
await page.keyboard.press('Escape')
await page.waitForTimeout(400)
await page.locator('.conversation-details-trigger').click()
await page.locator('.conversation-details').waitFor()
await page.waitForTimeout(300)
await page.screenshot({ path: join(out, '09-details-light-narrow.png') })
const box = await page.locator('.conversation-details-popup').boundingBox()
check('details popover fits the narrow viewport', !!box && box.x >= 0 && box.x + box.width <= 640, JSON.stringify(box))
await browser.close()
console.log(checks.every((item) => item.ok) ? 'ALL PASS' : 'SOME FAILED')
