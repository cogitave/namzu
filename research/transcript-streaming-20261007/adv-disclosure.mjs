// Adversarial: click a disclosure trigger (one that grows nothing) while a fast stream is running; does following survive?
import { require, startServer } from './serve.mjs'
const { chromium } = require('@playwright/test')
const { server, origin } = await startServer()
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
await page.goto(`${origin}?stress=20`)
await page.waitForFunction(() => document.querySelectorAll('.transcript-turn').length >= 20, null, { timeout: 60000 })
await page.waitForTimeout(500)
await page.evaluate(() => { window.__done = window.namzuPreviewStress.start({ paragraphs: 4, chunkChars: 24, intervalMs: 16 }) })
await page.waitForTimeout(1500)
const gap = () => page.evaluate(() => { const el = document.querySelector('.transcript'); return Math.round(el.scrollHeight - el.clientHeight - el.scrollTop) })
await page.evaluate((h) => { window.__panel = h; const b = document.createElement('button'); b.id = 'adv'; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-controls', 'advp'); const d = document.createElement('div'); d.id = 'advp'; d.style.height = (window.__panel ?? 60) + 'px'; document.querySelector('.transcript').appendChild(d); b.textContent = 'x'; b.style.position = 'absolute'; b.style.top = '0'; document.querySelector('.transcript').appendChild(b) }, Number(process.env.PANEL ?? 60))
await page.evaluate(() => document.getElementById('adv').click())
const gaps = []
for (let i = 0; i < 12; i++) { await page.waitForTimeout(250); gaps.push(await gap()) }
console.log('gaps after click', gaps.join(' '))
await page.evaluate(() => window.__done)
await browser.close(); await server.close()
