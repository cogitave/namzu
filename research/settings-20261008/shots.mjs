import { createRequire } from 'node:module'
const require = createRequire('/home/arda/workspaces/@cogitave/cogitave/namzu/packages/desktop/package.json')
const { chromium } = require('@playwright/test')
const out = '/home/arda/workspaces/@cogitave/cogitave/namzu/research/settings-20261008'
const base = 'http://127.0.0.1:5173/preview'
const browser = await chromium.launch()
const sections = ['general', 'projects', 'appearance', 'updates', 'speech', 'about']
const titles = { general: 'General', projects: 'Projects', appearance: 'Appearance', updates: 'Updates', speech: 'Speech', about: 'About' }
async function open(theme, size, query = '') {
	const context = await browser.newContext({ viewport: size, colorScheme: theme })
	await context.addInitScript((t) => localStorage.setItem('namzu.appearance', t), theme)
	const page = await context.newPage()
	page.on('pageerror', (e) => console.log('PAGEERROR', e.message))
	await page.goto(base + query)
	await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
	return { context, page }
}
for (const theme of ['dark', 'light']) {
	const { context, page } = await open(theme, { width: 1280, height: 800 }, '?update=available')
	await page.keyboard.press('Control+,')
	await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor()
	for (const section of sections) {
		await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: titles[section] }).click()
		await page.getByRole('heading', { level: 2, name: titles[section] }).waitFor()
		if (section === 'about') await page.getByText('Desktop app data').first().waitFor()
		await page.screenshot({ path: `${out}/${section}-${theme}.png` })
	}
	await context.close()
}
// narrow window
for (const theme of ['dark', 'light']) {
	const { context, page } = await open(theme, { width: 560, height: 800 })
	await page.getByRole('button', { name: 'Settings', exact: true }).click()
	await page.getByRole('heading', { level: 1, name: 'Settings' }).waitFor()
	await page.getByRole('button', { name: 'Toggle sidebar' }).first().click()
	await page.getByRole('navigation', { name: 'Settings sections' }).waitFor()
	await page.waitForTimeout(500) // artifact capture only: let the slide-in finish
	await page.screenshot({ path: `${out}/narrow-sections-${theme}.png` })
	await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Projects' }).click()
	await page.getByRole('heading', { level: 2, name: 'Projects' }).waitFor()
	await page.screenshot({ path: `${out}/narrow-projects-${theme}.png` })
	await context.close()
}
// search, remove dialog, busy refusal, sidebar remove affordances
{
	const { context, page } = await open('dark', { width: 1280, height: 800 }, '?removal-busy=sample-workspace')
	await page.getByRole('button', { name: 'Settings', exact: true }).click()
	await page.getByLabel('Search settings').fill('updat')
	await page.getByRole('heading', { level: 2, name: /result/ }).waitFor()
	await page.screenshot({ path: `${out}/search-dark.png` })
	await page.getByLabel('Search settings').fill('zzzz')
	await page.getByText('No results').waitFor()
	await page.screenshot({ path: `${out}/search-empty-dark.png` })
	await page.getByLabel('Search settings').fill('')
	await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Projects' }).click()
	await page.getByRole('button', { name: 'Remove Sample workspace…' }).click()
	await page.getByRole('alertdialog').waitFor()
	await page.screenshot({ path: `${out}/remove-dialog-dark.png` })
	await page.getByRole('button', { name: 'Remove project' }).click()
	await page.getByRole('alert').filter({ hasText: 'still running' }).waitFor()
	await page.screenshot({ path: `${out}/remove-refused-dark.png` })
	await page.getByRole('button', { name: 'Cancel' }).click()
	await page.getByRole('button', { name: 'Remove Sample docs…' }).click()
	await page.getByRole('button', { name: 'Remove project' }).click()
	await page.locator('.toast-title:visible', { hasText: 'Removed Sample docs.' }).first().waitFor()
	await page.screenshot({ path: `${out}/removed-from-settings-dark.png` })
	await context.close()
}
{
	const { context, page } = await open('dark', { width: 1280, height: 800 })
	await page.getByRole('link', { name: /x/ }).count()
	const row = page.locator('[data-project-group="sample-app"] .sidebar-project-heading')
	await row.hover()
	await page.screenshot({ path: `${out}/sidebar-hover-remove-dark.png`, clip: { x: 0, y: 0, width: 400, height: 500 } })
	await row.click({ button: 'right' })
	await page.getByRole('menuitem', { name: 'Remove project…' }).waitFor()
	await page.screenshot({ path: `${out}/sidebar-context-menu-dark.png`, clip: { x: 0, y: 0, width: 500, height: 500 } })
	await page.getByRole('menuitem', { name: 'Remove project…' }).click()
	await page.getByRole('alertdialog').getByText('Remove Sample app?').waitFor()
	await page.screenshot({ path: `${out}/sidebar-remove-dialog-dark.png` })
	await page.getByRole('button', { name: 'Remove project' }).click()
	await page.locator('[data-project-group="sample-app"]').waitFor({ state: 'detached' })
	await page.screenshot({ path: `${out}/sidebar-after-remove-dark.png` })
	await context.close()
}
await browser.close()
console.log('done')
