// Re-run: keep the desktop dev server up (pnpm --filter @namzu/desktop dev), then
//   node research/toasts-20261007/capture.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = join(dirname(fileURLToPath(import.meta.url)), 'artifacts')
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/preview'
const check = (name, ok, detail = '') => console.log(ok ? 'PASS' : 'FAIL', name, detail)
const browser = await chromium.launch()

async function open(colorScheme, reducedMotion = 'no-preference') {
	const ctx = await browser.newContext({
		viewport: { width: 1280, height: 800 },
		colorScheme,
		reducedMotion,
		timezoneId: 'UTC',
		locale: 'en-GB',
	})
	const page = await ctx.newPage()
	await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), colorScheme)
	await page.goto(url)
	await page.locator('.normal-transcript').waitFor()
	await page.waitForTimeout(800)
	// The page's own module instance, so this is the same hub the app calls.
	await page.evaluate(async () => {
		window.__notify = (await import('/src/renderer/notify.ts')).notify
	})
	return page
}
const live = (page) => page.locator('.toast-root:not([data-ending-style])')

for (const scheme of ['dark', 'light']) {
	const page = await open(scheme)
	await page.evaluate(() => window.__notify('Conversation ID copied.', { tone: 'success' }))
	await page.waitForTimeout(700)
	await page.screenshot({ path: join(out, `01-one-${scheme}.png`) })
	check(`${scheme}: one toast shows`, (await live(page).count()) === 1)
	const region = page.locator('.toast-viewport')
	check(`${scheme}: viewport is a polite live region`, (await region.getAttribute('aria-live')) === 'polite')

	await page.evaluate(() => {
		window.__notify('Project path copied.', { tone: 'success' })
		window.__notify('That file is not in this project.', { tone: 'warning' })
	})
	await page.waitForTimeout(700)
	await page.screenshot({ path: join(out, `02-three-stacked-${scheme}.png`) })
	check(`${scheme}: three toasts stack`, (await live(page).count()) === 3)
	await page.locator('.toast-viewport').hover({ position: { x: 20, y: -10 }, force: true }).catch(() => {})
	await page.mouse.move(640, 600)
	await page.locator('.toast-root').first().hover()
	await page.waitForTimeout(600)
	await page.screenshot({ path: join(out, `03-three-fanned-open-${scheme}.png`) })
	check(`${scheme}: hover fans the stack open`, (await page.locator('.toast-root[data-expanded]').count()) === 3)
	await page.close()
}

for (const scheme of ['dark', 'light']) {
	const page = await open(scheme)
	let undone = 0
	await page.exposeFunction('__undone', () => undone++)
	await page.evaluate(() =>
		window.__notify('Conversation archived.', {
			tone: 'success',
			action: { label: 'Undo', onClick: () => window.__undone() },
		}),
	)
	await page.waitForTimeout(700)
	await page.screenshot({ path: join(out, `04-action-${scheme}.png`) })
	await page.locator('.toast-action').click()
	await page.waitForTimeout(700)
	check(`${scheme}: the action runs once`, undone === 1)
	check(`${scheme}: the toast leaves after its action`, (await live(page).count()) === 0)

	await page.evaluate(() => window.__notify('Copy is unavailable.', { tone: 'error' }))
	await page.waitForTimeout(700)
	await page.screenshot({ path: join(out, `05-error-${scheme}.png`) })
	check(
		`${scheme}: an error is announced assertively`,
		(await page.locator('[role="alert"]', { hasText: 'Copy is unavailable.' }).count()) > 0 ||
			(await page.locator('[role="alertdialog"]').count()) > 0,
	)
	// Placement: above the composer, clear of the jump-to-latest button's row, inside the lane.
	const box = await page.locator('.toast-root').first().boundingBox()
	const composer = await page.locator('[data-chat-composer-overlay]').boundingBox()
	check(`${scheme}: toast sits above the composer`, box && composer && box.y + box.height < composer.y, JSON.stringify({ toast: box, composer }))
	const lane = await page.locator('.conversation-lane').boundingBox()
	check(`${scheme}: toast is inside the conversation lane`, box && lane && box.x >= lane.x && box.x + box.width <= lane.x + lane.width)
	await page.close()
}

{
	const page = await open('dark', 'reduce')
	await page.evaluate(() => window.__notify('Reduced motion.'))
	const t = await page.locator('.toast-root').first().evaluate((n) => getComputedStyle(n).transitionDuration)
	check('reduced motion removes the transition', /^0s(, 0s)*$/.test(t), t)
	await page.close()
}
{
	// Toasts vanish on their own: tone default is 4 s, so wait it out in the real page once.
	const page = await open('dark')
	await page.evaluate(() => window.__notify('Short lived.'))
	await page.locator('.toast-root').first().waitFor()
	await page.locator('.toast-root').first().waitFor({ state: 'detached', timeout: 12_000 })
	check('a plain toast leaves by itself', true)
	await page.close()
}
await browser.close()
