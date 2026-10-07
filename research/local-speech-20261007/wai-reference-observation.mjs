import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
const repo = process.cwd()
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium } = require('@playwright/test')
const browser = await chromium.launch({ headless: true })
const artifacts = join(repo, 'research/local-speech-20261007/artifacts')
await mkdir(artifacts, { recursive: true })
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
	await page.addInitScript(() => {
		localStorage.setItem('wai-session', JSON.stringify({ user: { id: 'reference-audit', name: 'Reference audit', email: 'reference@example.invalid' }, expiresAt: Date.now() + 86400000 }))
		localStorage.setItem('wai-theme', 'dark')
		localStorage.setItem('wai-locale', 'en')
	})
	await page.goto('http://127.0.0.1:5341/')
	await page.getByRole('link', { name: 'Compare noise-cancelling headphones', exact: true }).first().click()
	const row = page.getByRole('button', { name: /Worked for/ }).first()
	await row.waitFor()
	await page.evaluate(() => document.fonts.ready)
	await page.screenshot({ path: join(artifacts, 'wai-search-collapsed.png') })
	await row.click()
	await page.getByText('Sources', { exact: true }).first().waitFor().catch(() => {})
	await page.evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))))
	await row.scrollIntoViewIfNeeded()
	const measurements = await row.evaluate(element => {
		const measure = el => {
			const css = getComputedStyle(el), rect = el.getBoundingClientRect()
			return { text: el.innerText.slice(0, 150), bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, font: css.fontFamily, size: css.fontSize, lineHeight: css.lineHeight, color: css.color, gap: css.gap }
		}
		return { row: measure(element), parent: measure(element.parentElement), steps: [...element.parentElement.querySelectorAll('li')].map(measure) }
	})
	await page.screenshot({ path: join(artifacts, 'wai-search-expanded.png') })
	await writeFile(join(artifacts, 'wai-reference.json'), JSON.stringify({ at: new Date().toISOString(), viewport: { width: 1280, height: 900 }, theme: 'dark', source: '/home/arda/workspaces/@cogitave/cogitave-labs/wai', mockReference: true, measurements, limitations: ['UI-only reference with seeded data. No agent execution or backend semantics established.'] }, null, 2) + '\n')
	console.log(JSON.stringify(measurements))
} finally { await browser.close() }
