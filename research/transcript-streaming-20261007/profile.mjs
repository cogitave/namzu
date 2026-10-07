/** Where the main thread goes while a reply streams: CPU profile aggregated by self time. node profile.mjs [label] */
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
import { require, startServer } from './serve.mjs'
const { chromium } = require('@playwright/test')
const { server, origin } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(`${origin}?stress=300`)
await page.waitForFunction(() => document.querySelectorAll('.transcript-turn').length >= 300, null, { timeout: 60000 })
const cdp = await page.context().newCDPSession(page)
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 3000 })
await cdp.send('Profiler.start')
await page.evaluate(() => window.namzuPreviewStress.start({ paragraphs: 4, chunkChars: 24, intervalMs: 16 }))
const { profile } = await cdp.send('Profiler.stop')
const self = new Map()
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const dt = profile.timeDeltas
profile.samples.forEach((id, i) => {
	const f = byId.get(id).callFrame
	const key = `${f.functionName || '(anon)'} ${f.url.split('/').slice(-2).join('/')}:${f.lineNumber}`
	self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0))
})
const parent = new Map()
for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
const incl = new Map()
profile.samples.forEach((id, i) => {
	const seen = new Set()
	for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
		const f = byId.get(cur).callFrame
		if (!f.url.includes('/src/')) continue
		const key = `${f.functionName || '(anon)'} ${f.url.split('/src/')[1]}:${f.lineNumber}`
		if (seen.has(key)) continue
		seen.add(key)
		incl.set(key, (incl.get(key) ?? 0) + (dt[i] ?? 0))
	}
})
console.log('INCLUSIVE (src only)\n' + [...incl.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(7)} ms  ${k}`).join('\n'))
const total = [...self.values()].reduce((a, b) => a + b, 0)
const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${(v / 1000).toFixed(0).padStart(7)} ms ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
console.log(`total ${(total / 1000).toFixed(0)} ms\n${top.join('\n')}`)
await browser.close()
await server.close()
