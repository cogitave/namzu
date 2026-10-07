/** Real-renderer check: opening a work disclosure at the end must not be followed away from. node disclosure.mjs <label> */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { require, startServer } from './serve.mjs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const { chromium } = require('@playwright/test')
const { server, origin } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1100, height: 520 } })
await page.goto(origin)
await page.waitForSelector('.transcript .activity-trigger')
const read = () => page.evaluate(() => {
	const el = document.querySelector('.transcript')
	const t = [...document.querySelectorAll('.transcript .activity-trigger')]
	return { top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.clientHeight - el.scrollTop), expanded: t.map((x) => x.getAttribute('aria-expanded')) }
})
await page.evaluate(async () => { const el = document.querySelector('.transcript'); for (let i = 0; i < 20; i++) { el.scrollTop = el.scrollHeight; await new Promise((r) => requestAnimationFrame(r)) } })
const before = await read()
// Open the last collapsed disclosure, then see where the reader is once it has finished growing.
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const have = await page.evaluate(() => { const t = [...document.querySelectorAll('.transcript .activity-trigger[aria-expanded="false"]')].at(-1); t?.click(); return Boolean(t) })
await page.evaluate(() => new Promise((r) => setTimeout(r, 900)))
const after = await read()
const result = { before, after, opened: have, errors }
console.log(JSON.stringify(result))
await writeFile(join(dirname(fileURLToPath(import.meta.url)), 'artifacts', `disclosure-${process.argv[2] ?? 'run'}.json`), `${JSON.stringify(result, null, 2)}\n`)
await browser.close(); await server.close()
