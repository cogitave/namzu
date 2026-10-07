// Rerun: with the preview dev server up (pnpm --filter @namzu/desktop dev:preview, port 5173)
//   node research/effort-shader-20261007/capture.mjs research/effort-shader-20261007/artifacts
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = process.argv[2] ?? 'artifacts'
const names = ['low', 'medium', 'high', 'xhigh', 'max']
// The panel's own level count follows the preview model; the loop below reads it.
const args = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']

async function open(theme, viewport) {
	for (let i = 0; i < 4; i++) {
		try {
			const browser = await chromium.launch({ args })
			const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: theme, deviceScaleFactor: 2 })
			await ctx.addInitScript((t) => localStorage.setItem('namzu.appearance', t), theme)
			const page = await ctx.newPage()
			page.on('pageerror', (e) => console.log('pageerror', e.message))
			await page.goto('http://127.0.0.1:5173/preview')
			await page.waitForTimeout(1500)
			await page.setViewportSize(viewport)
			await page.waitForTimeout(500)
			await page.getByLabel(/^Model:/).click()
			await page.waitForTimeout(600)
			await page.locator('.composer-effort-panel').waitFor({ timeout: 5000 })
			return { browser, page }
		} catch (e) {
			console.log('retry', i, e.message.split('\n')[0])
		}
	}
	throw new Error('flow failed')
}

for (const [theme, vp] of [['dark', { width: 1280, height: 900 }], ['light', { width: 640, height: 720 }]]) {
	const { browser, page } = await open(theme, vp)
	const panel = page.locator('.composer-effort-panel')
	const clip = async () => {
		const b = await panel.boundingBox()
		return { x: b.x - 24, y: b.y - 8, width: b.width + 48, height: b.height + 24 }
	}
	const input = page.locator('.composer-effort-panel input[type=range]')
	await input.focus()
	await page.keyboard.press('Home')
	await page.waitForTimeout(1200)
	const count = await page.locator('.composer-effort-stop').count()
	for (let i = 0; i < count; i++) {
		if (i > 0) await page.keyboard.press('ArrowRight')
		await page.waitForTimeout(1300)
		await page.screenshot({ path: `${out}/${theme}-level-${i}-${names[i]}.png`, clip: await clip() })
	}
	for (const t of [0, 400, 800]) {
		await page.waitForTimeout(t === 0 ? 0 : 400)
		await page.screenshot({ path: `${out}/${theme}-top-t${t}.png`, clip: await clip() })
	}
	if (theme === 'dark') {
		const ms = await page.evaluate(
			() => new Promise((res) => {
				const d = []
				let last = performance.now()
				const f = (n) => { d.push(n - last); last = n; d.length < 121 ? requestAnimationFrame(f) : res(d.slice(1)) }
				requestAnimationFrame(f)
			}),
		)
		ms.sort((a, b) => a - b)
		console.log('frame ms mean', (ms.reduce((a, b) => a + b) / ms.length).toFixed(1), 'p50', ms[60].toFixed(1), 'p95', ms[113].toFixed(1), 'max', ms[119].toFixed(1))
		// Context loss falls back to the CSS fill; restore brings the shader back.
		const state = () => page.evaluate(() => document.querySelector('.composer-effort-panel')?.getAttribute('data-shader'))
		console.log('shader on:', await state())
		await page.evaluate(() => (window.__lose = document.querySelector('.composer-effort-shader canvas').getContext('webgl2').getExtension('WEBGL_lose_context')).loseContext())
		await page.waitForTimeout(300)
		console.log('after loss:', await state())
		await page.screenshot({ path: `${out}/dark-context-lost-css-fallback.png`, clip: await clip() })
		await page.evaluate(() => window.__lose.restoreContext())
		await page.waitForTimeout(600)
		console.log('after restore:', await state())
	}
	await browser.close()
}
