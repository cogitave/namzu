// Adversarial: reach a deferred (content-visibility) turn by scrollIntoView, then by selection of a found range; then return to the end.
import { require, startServer } from './serve.mjs'
const { chromium } = require('@playwright/test')
const { server, origin } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(`${origin}?stress=300`)
await page.waitForFunction(() => document.querySelectorAll('.transcript-turn').length >= 300, null, { timeout: 60000 })
await page.waitForTimeout(800)
const r = await page.evaluate(async () => {
	const sc = document.querySelector('.transcript')
	const out = {}
	const turn = document.querySelector('[data-transcript-turn="12"]') ?? document.querySelectorAll('.transcript-turn')[12]
	out.deferred = turn.hasAttribute('data-transcript-deferred')
	turn.scrollIntoView({ block: 'start' })
	await new Promise((r) => setTimeout(r, 300))
	let rect = turn.getBoundingClientRect(), box = sc.getBoundingClientRect()
	out.intoViewTopOffset = Math.round(rect.top - box.top)
	// Range-based reveal, as an in-transcript find would do
	const walker = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT)
	let node, found
	while ((node = walker.nextNode())) if (node.textContent.includes('Question 200:')) { found = node; break }
	const range = document.createRange(); range.setStart(found, 0); range.setEnd(found, 5)
	found.parentElement.scrollIntoView({ block: 'center' })
	await new Promise((r) => setTimeout(r, 300))
	const rr = range.getBoundingClientRect()
	out.rangeInView = rr.top >= box.top && rr.bottom <= box.bottom
	// focus
	return out
})
console.log(JSON.stringify(r))
await browser.close(); await server.close()
