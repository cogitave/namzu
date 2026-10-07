import { require, startServer } from './serve.mjs'
const { chromium } = require('@playwright/test')
const { server, origin } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(`${origin}?stress=${process.env.TURNS ?? 300}`)
await page.waitForFunction((n) => document.querySelectorAll('.transcript-turn').length >= n, Number(process.env.TURNS ?? 300), { timeout: 60000 })
await page.waitForTimeout(500)
const info = await page.evaluate(() => {
	const t = document.querySelector('.normal-transcript')
	const chain = []
	for (let el = t; el; el = el.parentElement) chain.push(`${el.tagName}.${(el.className || '').toString().slice(0, 40)} sh=${el.scrollHeight} ch=${el.clientHeight} st=${Math.round(el.scrollTop)} oy=${getComputedStyle(el).overflowY}`)
	return chain
})
const gaps = await page.evaluate(async () => {
	const el = document.querySelector('.transcript')
	const out = []
	const timer = setInterval(() => out.push(Math.round(el.scrollHeight - el.clientHeight - el.scrollTop)), 300)
	await window.namzuPreviewStress.start({ paragraphs: 3, chunkChars: 24, intervalMs: 16 })
	clearInterval(timer)
	return out
})
console.log(gaps.join(' '))
await browser.close(); await server.close()
