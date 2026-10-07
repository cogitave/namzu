/**
 * Real-renderer measurement of the transcript: Playwright chromium against the running Vite preview.
 *   node measure.mjs <label> [origin]   -> writes artifacts/<label>.json
 * The preview fixture is src/dev/preview-stress.ts (300 settled turns + a timer-driven streamed reply).
 * Nothing here races a clock to decide pass/fail; it only records what the browser reports.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const label = process.argv[2] ?? 'run'
const out = join(here, 'artifacts')
await mkdir(out, { recursive: true })
import { require, startServer } from './serve.mjs'
const { chromium } = require('@playwright/test')
// Its own Vite server with HMR off: edits made elsewhere in the tree cannot reload the page mid-run.
// Pass an origin to measure an already running server instead. REACT=production and BASELINE=1: see serve.mjs.
let server
let origin = process.argv[3]
if (!origin) ({ server, origin } = await startServer())
const stats = (values) => {
	if (!values.length) return { n: 0 }
	const sorted = [...values].sort((a, b) => a - b)
	const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
	const sum = values.reduce((a, b) => a + b, 0)
	return { n: values.length, mean: +(sum / values.length).toFixed(2), p50: +at(0.5).toFixed(2), p95: +at(0.95).toFixed(2), max: +sorted.at(-1).toFixed(2) }
}

const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.error('NAV', f.url()) })
page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE', m.text().slice(0, 200)) })
page.on('pageerror', (error) => errors.push(String(error)))
await page.addInitScript(() => {
	const probe = { deliveries: [], renders: [], longtasks: [], frames: [] }
	window.__probe = probe
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) probe.longtasks.push({ at: entry.startTime, duration: entry.duration })
	}).observe({ type: 'longtask', buffered: true })
	let api
	Object.defineProperty(window, 'namzu', {
		configurable: true,
		get: () => api,
		set(value) {
			api = { ...value, onEvent: (listener) => value.onEvent((event) => {
				if (event.kind === 'update') probe.deliveries.push(performance.now())
				listener(event)
			}) }
		},
	})
})

const t0 = Date.now()
await page.goto(`${origin}?stress=300`)
await page.waitForSelector('.normal-transcript .transcript-turn')
await page.waitForFunction(() => document.querySelectorAll('.transcript-turn').length >= 300, null, { timeout: 60000 })
const loadMs = Date.now() - t0
const result = { label, origin, turns: await page.evaluate(() => document.querySelectorAll('.transcript-turn').length), loadMs, errors }

const cdp = await page.context().newCDPSession(page)
await cdp.send('Performance.enable')
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))

// Scroll cost over the settled history: drive the wheel through the whole thing.
await page.evaluate(() => {
	const node = document.querySelector('.normal-transcript')?.parentElement
	const scroller = [...document.querySelectorAll('*')].find((el) => el.scrollHeight > el.clientHeight + 200 && getComputedStyle(el).overflowY !== 'visible' && el.contains(document.querySelector('.normal-transcript')))
	window.__scroller = scroller ?? node
})
const geometry = await page.evaluate(() => ({ scrollHeight: __scroller.scrollHeight, clientHeight: __scroller.clientHeight, scrollTop: __scroller.scrollTop }))
result.geometry = geometry
const scrollFrames = await page.evaluate(async () => {
	const frames = []
	let last = performance.now()
	let running = true
	const tick = (now) => { frames.push(now - last); last = now; if (running) requestAnimationFrame(tick) }
	requestAnimationFrame(tick)
	const el = __scroller
	el.scrollTop = el.scrollHeight
	await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
	for (let y = el.scrollHeight; y > 0; y -= 600) { el.scrollTop = y; await new Promise((r) => requestAnimationFrame(r)) }
	for (let y = 0; y < el.scrollHeight; y += 600) { el.scrollTop = y; await new Promise((r) => requestAnimationFrame(r)) }
	running = false
	return frames
})
result.scrollThroughHistoryFrameMs = stats(scrollFrames)

// Jump to the latest from the top, as the button does.
await page.evaluate(() => { __scroller.scrollTop = 0 })
await page.waitForSelector('button[aria-label*="atest" i], button:has-text("latest")', { timeout: 5000 }).catch(() => {})
const jump = page.locator('button[aria-label*="atest" i]').first()
if (await jump.count()) {
	await jump.click()
	await page.evaluate(() => new Promise((r) => { const el = __scroller; let n = 0; const check = () => { if (el.scrollHeight - el.clientHeight - el.scrollTop <= 2 || ++n > 120) r(); else requestAnimationFrame(check) }; check() }))
	result.jumpToLatestGap = await page.evaluate(() => __scroller.scrollHeight - __scroller.clientHeight - __scroller.scrollTop)
} else result.jumpToLatestGap = 'no button'

// Anchors into skipped turns: scrollIntoView, find-in-page and the scroll position of a far turn.
result.anchors = await page.evaluate(async () => {
	const el = __scroller
	const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
	el.scrollTop = 0
	await frames()
	const heading = [...document.querySelectorAll('.transcript-turn h3')].find((h) => h.textContent.startsWith('Turn 150:'))
	heading.scrollIntoView({ block: 'center' })
	await frames()
	const box = heading.getBoundingClientRect()
	const into = { top: Math.round(box.top), viewport: innerHeight, inView: box.top >= 0 && box.bottom <= innerHeight }
	el.scrollTop = 0
	await frames()
	const found = window.find('Turn 220: what changed')
	await frames()
	const selected = getSelection()?.toString() ?? ''
	const range = getSelection()?.rangeCount ? getSelection().getRangeAt(0).getBoundingClientRect() : null
	return { scrollIntoView: into, findInPage: { found, selected, inView: range ? range.top >= 0 && range.bottom <= innerHeight : false } }
})
await page.evaluate(() => { getSelection()?.removeAllRanges() })

// Streaming: the transcript follows the end while a long reply arrives on a timer.
// Go to the end the way a reader does: keep going until the page stops growing under the scroll.
await page.evaluate(async () => {
	const el = __scroller
	let steady = 0
	for (let i = 0; i < 600 && steady < 5; i++) {
		const gap = el.scrollHeight - el.clientHeight - el.scrollTop
		if (gap > 2) { el.scrollTop = el.scrollHeight; steady = 0 } else steady++
		await new Promise((r) => requestAnimationFrame(r))
	}
})
await page.evaluate(() => {
	const probe = window.__probe
	probe.deliveries.length = 0
	probe.longtasks.length = 0
	probe.running = true
	probe.gaps = []
	const sampler = setInterval(() => { if (!probe.running) return clearInterval(sampler); probe.gaps.push(Math.round(__scroller.scrollHeight - __scroller.clientHeight - __scroller.scrollTop)) }, 250)
	const tick = (now) => { probe.frames.push(now); if (probe.running) requestAnimationFrame(tick) }
	requestAnimationFrame(tick)
	// Time from a delivered delta to the next change of the streamed message's text node.
	let pending = []
	const observer = new MutationObserver(() => {
		const now = performance.now()
		for (const at of pending) probe.renders.push(now - at)
		pending = []
		probe.lastMutation = now
	})
	window.__arm = () => { pending.push(performance.now()) }
	const target = document.querySelector('.normal-transcript')
	observer.observe(target, { childList: true, subtree: true, characterData: true })
	const original = probe.deliveries
	probe.deliveries = new Proxy(original, { get(t, k) { if (k === 'push') return (v) => { pending.push(v); return t.push(v) }; return t[k] } })
})
const before = await metrics()
const wallStart = Date.now()
await page.evaluate(() => window.namzuPreviewStress.start({ paragraphs: 12, chunkChars: 24, intervalMs: 16 }))
const wallMs = Date.now() - wallStart
const after = await metrics()
const probe = await page.evaluate(() => { window.__probe.running = false; const p = window.__probe; return { gaps: p.gaps, renders: p.renders, longtasks: p.longtasks, frames: p.frames, deliveries: p.deliveries.length } })
const frameDeltas = probe.frames.slice(1).map((value, i) => value - probe.frames[i])
result.stream = {
	paragraphs: 12,
	deltas: probe.deliveries,
	wallMs,
	timeToRenderPerDeltaMs: stats(probe.renders),
	frameMs: { ...stats(frameDeltas), over33: frameDeltas.filter((v) => v > 33).length, over100: frameDeltas.filter((v) => v > 100).length },
	longTasks: { count: probe.longtasks.length, totalMs: +probe.longtasks.reduce((a, b) => a + b.duration, 0).toFixed(1), maxMs: +Math.max(0, ...probe.longtasks.map((t) => t.duration)).toFixed(1) },
	cdp: Object.fromEntries(['TaskDuration', 'ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration'].map((k) => [k, +(((after[k] ?? 0) - (before[k] ?? 0)) * 1000).toFixed(0)])),
}
result.stream.followGapDuringStream = { max: Math.max(...probe.gaps), last: probe.gaps.at(-1), samples: probe.gaps.length }
result.finalFollowGap = await page.evaluate(() => __scroller.scrollHeight - __scroller.clientHeight - __scroller.scrollTop)
await page.screenshot({ path: join(out, `${label}.png`) })
await writeFile(join(out, `${label}.json`), `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
await browser.close()
await server?.close()
