/** Actual-renderer proof for the sidebar row hover: buttons, frame sampling, card, menu. */
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium } = require('@playwright/test')
const out = join(repo, 'research/sidebar-hover-20261008')
const browser = await chromium.launch()
let failed = false
const check = (ok, what) => {
	console.log(ok ? 'ok  ' : 'FAIL', what)
	if (!ok) failed = true
}
for (const scheme of ['dark', 'light']) {
	const ctx = await browser.newContext({ viewport: { width: 1100, height: 760 }, colorScheme: scheme })
	const page = await ctx.newPage()
	await page.addInitScript((v) => localStorage.setItem('namzu.appearance', v), scheme)
	await page.goto('http://127.0.0.1:5173/preview')
	await page.waitForSelector('.sidebar-thread-item')
	await page.waitForTimeout(1200)
	const row = page.locator('.sidebar-recent-list .sidebar-thread-item').nth(1)
	let box = await row.boundingBox()
	for (let i = 0; i < 20; i++) {
		await page.waitForTimeout(100)
		const next = await row.boundingBox()
		const same = next.y === box.y && next.x === box.x
		box = next
		if (same && i > 3) break
	}
	const rowName = await row.locator('.conversation-row-title').textContent()
	console.log(scheme, 'row', rowName, JSON.stringify(box))
	// Frame sampler: every animation frame, what the row's time and buttons compute to.
	const sample = (ms) =>
		page.evaluate(
			(args) =>
				new Promise((done) => {
					const li = document.querySelectorAll('.sidebar-recent-list .sidebar-thread-item')[args.index]
					const frames = []
					const t0 = performance.now()
					const tick = () => {
						const shown = (el) => {
							const cs = getComputedStyle(el)
							let node = el
							while (node && node !== li.parentElement) {
								const s = getComputedStyle(node)
								if (s.visibility === 'hidden' || Number(s.opacity) === 0) return false
								node = node.parentElement
							}
							return cs.display !== 'none'
						}
						frames.push({
							t: Math.round(performance.now() - t0),
							time: shown(li.querySelector('.conversation-age')),
							actions: shown(li.querySelector('.sidebar-thread-actions')),
							card: !!document.querySelector('[data-slot="thread-hover-card"]'),
						})
						if (performance.now() - t0 < args.ms) requestAnimationFrame(tick)
						else done(frames)
					}
					requestAnimationFrame(tick)
				}),
			{ ms, index: 1 },
		)
	await page.mouse.move(700, 600)
	await page.waitForTimeout(200)
	// Hover in then out, 90 ms apart so the card (450 ms) never opens in this pass.
	const run = sample(700)
	await page.waitForTimeout(100)
	await page.mouse.move(box.x + 40, box.y + box.height / 2)
	await page.waitForTimeout(150)
	await page.mouse.move(700, 600)
	const frames = await run
	const both = frames.filter((f) => f.time && f.actions).length
	const states = frames.map((f) => (f.actions ? 'A' : f.time ? 'T' : '-'))
	const runs = states.join('').replace(/(.)\1+/g, '$1')
	console.log(scheme, 'frames', frames.length, 'sequence', runs)
	check(both === 0, `${scheme}: time and buttons never share a frame (${both} frames)`)
	check(!states.includes('T'), `${scheme}: the time never flashes in either direction`)
	check(runs === '-A-', `${scheme}: one swap in, one swap out (${runs})`)
	// Pin and Archive buttons, tooltips.
	await page.mouse.move(box.x + 40, box.y + box.height / 2)
	await page.waitForTimeout(100)
	const names = await row.locator('.sidebar-thread-action').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')))
	check(JSON.stringify(names) === '["Pin","Archive"]', `${scheme}: buttons ${names}`)
	await page.screenshot({ path: join(out, `${scheme}-hover-buttons.png`), clip: { x: 0, y: Math.max(0, box.y - 70), width: 345, height: 190 } })
	// The card after the delay.
	await page.mouse.move(box.x + 60, box.y + box.height / 2 + 1)
	await page.waitForSelector('[data-slot="thread-hover-card"]', { timeout: 3000 })
	await page.waitForTimeout(250)
	const card = await page.locator('[data-slot="thread-hover-card"]').innerText()
	console.log(scheme, 'card:', JSON.stringify(card))
	await page.screenshot({ path: join(out, `${scheme}-hover-card.png`), clip: { x: 0, y: Math.max(0, box.y - 70), width: 700, height: 220 } })
	await page.mouse.move(700, 600)
	await page.waitForTimeout(300)
	check((await page.locator('[data-slot="thread-hover-card"]').count()) === 0, `${scheme}: card closes on pointer leave`)
	// Card with a branch: a project row.
	const project = page.locator('.sidebar-project-list .sidebar-thread-item').first()
	if (await project.count()) {
		const pb = await project.boundingBox()
		await page.mouse.move(pb.x + 60, pb.y + pb.height / 2)
		await page.waitForSelector('[data-slot="thread-hover-card"]', { timeout: 3000 })
		await page.waitForTimeout(300)
		console.log(scheme, 'project card:', JSON.stringify(await page.locator('[data-slot="thread-hover-card"]').innerText()))
		await page.screenshot({ path: join(out, `${scheme}-hover-card-branch.png`), clip: { x: 0, y: Math.max(0, pb.y - 60), width: 700, height: 220 } })
		// Scroll closes it.
		await page.mouse.wheel(0, 40)
		await page.waitForTimeout(200)
		await page.mouse.move(700, 600)
	}
	// Right click menu.
	await row.click({ button: 'right' })
	await page.waitForTimeout(400)
	await page.waitForSelector('.conversation-actions-popup')
	const items = await page.locator('.conversation-actions-popup [role="menuitem"]').allTextContents()
	console.log(scheme, 'context menu items', JSON.stringify(items))
	check(items.some((t) => t.includes('Archive')) && items.some((t) => /Pin/.test(t)), `${scheme}: right-click opens the full menu`)
	check((await page.locator('[data-slot="thread-hover-card"]').count()) === 0, `${scheme}: no card beside an open menu (${await page.locator('[data-slot="thread-hover-card"]').allTextContents()})`)
	await page.screenshot({ path: join(out, `${scheme}-context-menu.png`), clip: { x: 0, y: Math.max(0, box.y - 70), width: 520, height: 520 } })
	await page.keyboard.press('Escape')
	await page.waitForTimeout(200)
	// Keyboard: focus the row, Shift+F10.
	await page.mouse.move(700, 600)
	await row.locator('button.sidebar-conversation-button').focus()
	await page.keyboard.press('Shift+F10')
	await page.waitForSelector('.conversation-actions-popup', { timeout: 2000 }).catch(() => {})
	check((await page.locator('.conversation-actions-popup').count()) === 1, `${scheme}: Shift+F10 opens the menu on a focused row`)
	await page.keyboard.press('Escape')
	await page.waitForTimeout(200)
	check(await row.locator('button.sidebar-conversation-button').evaluate((el) => el === document.activeElement), `${scheme}: focus returns to the row`)
	// Pin by button.
	await page.mouse.move(box.x + 40, box.y + box.height / 2)
	await page.waitForTimeout(100)
	await row.locator('.sidebar-thread-action[aria-label="Pin"]').click()
	await page.waitForTimeout(400)
	const body = () => page.evaluate(() => document.body.innerText)
	check(/pinned\./i.test(await body()), `${scheme}: Pin button pins and toasts`)
	check((await row.locator('.sidebar-thread-action[aria-label="Unpin"]').count()) === 1 || (await page.locator('.sidebar-recent-list .sidebar-thread-item').first().locator('[aria-label="Unpin"]').count()) === 1, `${scheme}: the pinned row now offers Unpin`)
	const before = await page.locator('.sidebar-recent-list .sidebar-thread-item').count()
	const target = page.locator('.sidebar-recent-list .sidebar-thread-item').last()
	const tb = await target.boundingBox()
	await page.mouse.move(tb.x + 40, tb.y + tb.height / 2)
	await page.waitForTimeout(150)
	await target.locator('.sidebar-thread-action[aria-label="Archive"]').click()
	await page.waitForTimeout(500)
	const text = await body()
	console.log(scheme, 'archive toast', /archived/i.test(text), /Undo/.test(text), 'rows', before, '->', await page.locator('.sidebar-recent-list .sidebar-thread-item').count())
	check(/archived/i.test(text), `${scheme}: Archive archives at once and toasts`)
	check(!(await body()).includes('Archive this conversation?'), `${scheme}: no confirmation dialog`)
	await ctx.close()
}
await browser.close()
process.exit(failed ? 1 : 0)
