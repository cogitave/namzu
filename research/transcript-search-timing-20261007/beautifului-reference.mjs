import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

const require = createRequire(join(process.cwd(), 'packages/desktop/package.json'))
const { chromium } = require('@playwright/test')
const directory = join(process.cwd(), 'research/transcript-search-timing-20261007/reference-beautifului')
await mkdir(directory, { recursive: true })
const browser = await chromium.launch({ headless: true })
const observations = []
try {
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' })
	await page.goto('https://www.beautifului.dev/', { waitUntil: 'networkidle' })
	await page.evaluate(() => document.fonts.ready)
	const settle = () => page.evaluate(() => Promise.all(document.getAnimations()
		.filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
		.map(animation => animation.finished.catch(() => {}))))
	async function record(id, name, expanded) {
		const section = page.locator(`#${id}`)
		await section.scrollIntoViewIfNeeded()
		if (expanded !== undefined) {
			const toggle = section.locator('button[aria-expanded]').first()
			if ((await toggle.getAttribute('aria-expanded')) !== String(expanded)) await toggle.click()
			if (expanded && id === 'thinking-state') {
				await section.locator('.grid .relative .flex > div').first().waitFor({ state: 'visible' })
			}
		}
		await settle()
		await section.screenshot({ path: join(directory, `${name}.png`) })
		observations.push(await section.evaluate((element, state) => {
			const measure = node => {
				const css = getComputedStyle(node), box = node.getBoundingClientRect()
				return { text: node.textContent.trim().slice(0, 140), width: box.width, height: box.height,
					font: css.fontFamily, size: css.fontSize, weight: css.fontWeight, lineHeight: css.lineHeight,
					color: css.color, gap: css.gap, transition: css.transition, animation: css.animation,
					expanded: node.getAttribute('aria-expanded'), pressed: node.getAttribute('aria-pressed') }
			}
			const surface = element.querySelector('.primitive-demo-surface')
			return { state, id: element.id, surface: measure(surface),
				controls: [...surface.querySelectorAll('button[aria-expanded], button[aria-pressed], a')].map(measure),
				textRoles: [...surface.querySelectorAll('span[role="status"], p')].map(measure),
				motion: [...surface.querySelectorAll('[style]')].map(measure).filter(row =>
					!row.transition.startsWith('all 0s') || !row.animation.startsWith('none 0s')).slice(0, 15) }
		}, name))
	}
	const thinking = page.locator('#thinking-state')
	await record('thinking-state', 'thinking-collapsed', false)
	await record('thinking-state', 'thinking-steps-expanded', true)
	await thinking.getByRole('button', { name: 'Search', exact: true }).click()
	await thinking.getByText('Joy Cone', { exact: true }).waitFor({ state: 'attached' })
	await record('thinking-state', 'thinking-search-expanded', true)
	await record('thinking-state', 'thinking-search-collapsed', false)
	await record('streaming-text', 'answer-sources-collapsed', false)
	await record('streaming-text', 'answer-sources-expanded', true)
	await record('tool-chips', 'tool-chips-expanded')
	await record('task-rows', 'task-rows')
	await record('chat-composer', 'chat-flavors')
	await page.locator('#chat-composer').getByRole('button', { name: 'Suppliers', exact: true }).click()
	await record('chat-composer', 'chat-suppliers')
	await writeFile(join(directory, 'observations.json'), JSON.stringify({
		at: new Date().toISOString(), url: page.url(), viewport: { width: 1280, height: 900 },
		freshContext: true, theme: 'reference default (dark)', executedAgent: false, observations,
		limitations: ['Public gallery examples, not a running agent.', 'Theme is the reference site default; no claim of pixel parity with Namzu.', 'No reference code copied into the product.'],
	}, null, 2) + '\n')
	console.log(JSON.stringify({ directory, states: observations.map(row => row.state) }))
} finally {
	await browser.close()
}
