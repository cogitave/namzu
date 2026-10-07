// Re-run with the desktop dev server up (pnpm --filter @namzu/desktop dev):
//   node research/edit-approval-20261007/capture.mjs
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../packages/desktop/node_modules/@playwright/test/index.mjs'

const out = join(dirname(fileURLToPath(import.meta.url)), 'artifacts')
const url = process.env.PREVIEW_URL ?? 'http://127.0.0.1:5173/preview'
const check = (name, ok, detail = '') => console.log(ok ? 'PASS' : 'FAIL', name, detail)
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader'] })

async function open(scheme, viewport) {
	const ctx = await browser.newContext({ viewport, colorScheme: scheme, timezoneId: 'UTC', locale: 'en-GB' })
	const page = await ctx.newPage()
	await page.addInitScript((value) => localStorage.setItem('namzu.appearance', value), scheme)
	page.on('framenavigated', (f) => f === page.mainFrame() && console.log('NAVIGATED', f.url()))
	await page.goto(url)
	await page.locator('.normal-transcript').waitFor()
	await page.waitForTimeout(800)
	return page
}
const raise = (page, kind) => page.evaluate((k) => window.namzuPreviewApproval.raise(k), kind)
const answers = (page) => page.evaluate(() => window.namzuPreviewApproval.answers)
const card = (page) => page.locator('section[aria-label="Tool approval"]')
async function settle(page) {
	await card(page).waitFor()
	// The diff web component loads its highlighter after the card mounts; wait for rows to appear.
	if (await card(page).locator('.approval-diff-scroll').count())
		await page.waitForFunction(
			() => (document.querySelector('.approval-diff-scroll')?.getBoundingClientRect().height ?? 0) > 20,
		)
	await page.waitForTimeout(500)
}
async function shot(page, name) {
	await page.screenshot({ path: join(out, `${name}.png`) })
}

// ---- dark 1440x900
{
	const page = await open('dark', { width: 1440, height: 900 })
	await raise(page, 'edit')
	await settle(page)
	// Initial focus must not be pulled into the card.
	check('focus stays out of the card', await page.evaluate(() => !document.activeElement?.closest('section[aria-label="Tool approval"]')))
	check('title', (await card(page).locator('.approval-title').textContent()) === 'Edit routes.ts?')
	check('full path as tooltip', (await card(page).locator('.approval-title').getAttribute('title')) === '/home/arda/projects/sample-app/src/server/routes.ts')
	check('counts shown', /\+\d+/.test(await card(page).locator('.approval-counts').innerText()), await card(page).locator('.approval-counts').innerText())
	check('buttons in order', (await card(page).locator('.approval-footer button').allInnerTexts()).join('|').replace(/\s+/g, '') === '|Edit|Reject|Accept'.replace(/\s+/g, ''), (await card(page).locator('.approval-footer button').allInnerTexts()).join('|'))
	await shot(page, 'dark-edit')
	const wrapButton = card(page).getByRole('button', { name: 'Wrap long lines' })
	check('wrap aria-pressed false', (await wrapButton.getAttribute('aria-pressed')) === 'false')
	await wrapButton.click()
	check('wrap aria-pressed true', (await wrapButton.getAttribute('aria-pressed')) === 'true')
	await page.waitForTimeout(600)
	await shot(page, 'dark-edit-wrap')
	// Contrast of the two coloured buttons against the card surface.
	const contrast = await page.evaluate(() => {
		const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number)
		const lum = ([r, g, b]) => {
			const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
		}
		const ratio = (a, b) => {
			const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
			return (x + 0.05) / (y + 0.05)
		}
		const probe = document.createElement('div')
		probe.style.color = 'var(--surface-raised)'
		document.body.append(probe)
		const surface = parse(getComputedStyle(probe).color)
		probe.remove()
		const text = (tone) => parse(getComputedStyle(document.querySelector(`.approval-button[data-tone="${tone}"]`)).color)
		return { reject: ratio(text('reject'), surface), accept: ratio(text('accept'), surface) }
	})
	check('dark contrast AA', contrast.reject >= 4.5 && contrast.accept >= 4.5, JSON.stringify(contrast))
	// Edit mode.
	await card(page).getByRole('button', { name: 'Edit', exact: true }).click()
	const field = card(page).getByPlaceholder('Tell Namzu what to do instead')
	check('note field focused', await field.evaluate((el) => el === document.activeElement))
	check('footer swapped', (await card(page).locator('.approval-footer button').allInnerTexts()).join('|') === 'Send|Cancel')
	check('send disabled when empty', await card(page).getByRole('button', { name: 'Send' }).isDisabled())
	await field.fill('use a guard clause instead')
	await shot(page, 'dark-edit-mode')
	await field.press('Escape')
	check('escape cancels the field', (await field.count()) === 0)
	check('escape sent nothing', (await answers(page)).length === 0)
	check('focus returned to Edit', await page.evaluate(() => document.activeElement?.textContent === 'Edit'))
	await card(page).getByRole('button', { name: 'Edit', exact: true }).click()
	await card(page).getByPlaceholder('Tell Namzu what to do instead').fill('use a guard clause instead')
	await card(page).getByRole('button', { name: 'Send' }).click()
	const sent = await answers(page)
	check('send rejects with the note', sent.length === 1 && sent[0].response.outcome === 'reject' && sent[0].response.feedback === 'The user declined this change and said: use a guard clause instead', JSON.stringify(sent))
	await card(page).waitFor({ state: 'detached' })

	// Create
	await raise(page, 'create')
	await settle(page)
	check('create title', (await card(page).locator('.approval-title').textContent()) === 'Create README.md?')
	check('no warning on create', (await card(page).locator('.approval-warning').count()) === 0)
	await shot(page, 'dark-create')
	await card(page).getByRole('button', { name: 'Reject' }).click()
	const rejected = (await answers(page)).at(-1)
	check('reject is plain', rejected.response.outcome === 'reject' && rejected.response.feedback === undefined, JSON.stringify(rejected))

	// Command
	await raise(page, 'command')
	await settle(page)
	check('command title', (await card(page).locator('.approval-title').textContent()) === 'Run this command?')
	check('no wrap button on a command', (await card(page).getByRole('button', { name: 'Wrap long lines' }).count()) === 0)
	check('warning on destructive', (await card(page).locator('.approval-warning').count()) === 1)
	await shot(page, 'dark-command')
	// Ctrl+Enter with focus OUTSIDE the card does nothing.
	await page.locator('textarea').first().focus()
	await page.keyboard.press('Control+Enter')
	check('ctrl+enter outside the card does not accept', (await answers(page)).length === 2)
	await card(page).locator('.approval-command').focus()
	await page.keyboard.press('Control+Enter')
	const accepted = (await answers(page)).at(-1)
	check('ctrl+enter inside the card accepts', accepted.response.outcome === 'approve', JSON.stringify(accepted))

	// No preview
	await raise(page, 'none')
	await settle(page)
	check('no-preview label', (await card(page).locator('.approval-note').first().innerText()).startsWith('Preview not available'))
	await shot(page, 'dark-no-preview')
	await card(page).getByRole('button', { name: 'Accept' }).click()
	check('accept approves', (await answers(page)).at(-1).response.outcome === 'approve')

	// Other tool
	await raise(page, 'other')
	await settle(page)
	check('other title', (await card(page).locator('.approval-title').textContent()) === 'Allow web fetch?')
	await card(page).locator('.approval-details summary').click()
	await shot(page, 'dark-other')
	await card(page).getByRole('button', { name: 'Reject' }).click()

	// Long diff: height cap and show more
	await raise(page, 'long')
	await settle(page)
	const scroller = card(page).locator('.approval-diff-scroll')
	const capped = await scroller.evaluate((el) => el.getBoundingClientRect().height)
	check('capped at 280px', Math.round(capped) === 280, String(capped))
	await shot(page, 'dark-long')
	await card(page).getByRole('button', { name: 'Show more' }).click()
	const tall = await scroller.evaluate((el) => el.getBoundingClientRect().height)
	check('show more grows the box', tall > 280 && tall <= 900 * 0.6 + 1, String(tall))
	await shot(page, 'dark-long-expanded')
	await card(page).getByRole('button', { name: 'Show less' }).click()
	await card(page).getByRole('button', { name: 'Reject' }).click()

	// Two pending
	await raise(page, 'edit')
	await raise(page, 'command')
	await settle(page)
	check('1 of 2', (await card(page).locator('.approval-count').textContent()) === '1 of 2')
	await shot(page, 'dark-two-pending')
	await page.close()
}

// ---- light 900x720
{
	const page = await open('light', { width: 900, height: 720 })
	await raise(page, 'edit')
	await settle(page)
	await shot(page, 'light-edit')
	await card(page).getByRole('button', { name: 'Wrap long lines' }).click()
	await card(page).getByRole('button', { name: 'Edit', exact: true }).click()
	await card(page).getByPlaceholder('Tell Namzu what to do instead').fill('keep the old route and add a new one')
	await page.waitForTimeout(600)
	await shot(page, 'light-edit-mode-wrap')
	const contrast = await page.evaluate(() => {
		const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number)
		const lum = ([r, g, b]) => {
			const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
			return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
		}
		const ratio = (a, b) => {
			const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
			return (x + 0.05) / (y + 0.05)
		}
		const probe = document.createElement('div')
		probe.style.color = 'var(--surface-raised)'
		document.body.append(probe)
		const surface = parse(getComputedStyle(probe).color)
		probe.remove()
		const style = (tone) => {
			const probeTone = document.createElement('span')
			probeTone.style.color = tone === 'reject' ? 'var(--error-foreground)' : 'var(--update-foreground)'
			document.body.append(probeTone)
			const color = parse(getComputedStyle(probeTone).color)
			probeTone.remove()
			return color
		}
		return { reject: ratio(style('reject'), surface), accept: ratio(style('accept'), surface) }
	})
	check('light contrast AA', contrast.reject >= 4.5 && contrast.accept >= 4.5, JSON.stringify(contrast))
	await card(page).getByRole('button', { name: 'Cancel' }).click()
	await card(page).getByRole('button', { name: 'Reject' }).click()
	for (const kind of ['create', 'command', 'none']) {
		await raise(page, kind)
		await settle(page)
		await shot(page, `light-${kind === 'none' ? 'no-preview' : kind}`)
		await card(page).getByRole('button', { name: 'Reject' }).click()
	}
	await page.close()
}
await browser.close()
