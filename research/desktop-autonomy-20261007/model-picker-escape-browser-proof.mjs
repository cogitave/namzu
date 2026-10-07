/** Isolated real Chromium keyboard proof; all model catalogues are fixture data. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const { chromium, expect } = require('@playwright/test')
const artifacts = join(repo, 'research/desktop-autonomy-20261007/artifacts')
const receipt = {
	passed: false,
	realBrowserKeyboard: true,
	isolation: 'Vite preview with fixture-only models',
	nativeActions: 0,
	providerRequests: 0,
	checks: [],
}
const server = await createServer({
	root: join(repo, 'packages/desktop'),
	configFile: join(repo, 'packages/desktop/vite.config.ts'),
	server: { host: '127.0.0.1', port: 0, strictPort: false },
	logLevel: 'error',
})
let browser
try {
	await server.listen()
	const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
	browser = await chromium.launch({ headless: true })
	const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
	await context.route('**/*', (route) =>
		new URL(route.request().url()).origin === new URL(origin).origin
			? route.continue()
			: route.abort(),
	)
	const page = await context.newPage()
	page.setDefaultTimeout(12000)
	const errors = []
	page.on('pageerror', (error) => errors.push(error.message))
	await page.goto(origin)
	await page.getByRole('status', { name: 'Design preview', exact: true }).waitFor()
	await page.evaluate(async () => {
		const React = (await import('/node_modules/.vite/deps/react.js')).default
		const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
		const { ModelPicker } = await import('/src/renderer/model-picker.tsx')
		const host = document.createElement('div')
		host.style.cssText = 'padding:300px 40px 0;min-height:700px;'
		document.getElementById('root').style.display = 'none'
		document.body.append(host)
		const catalogue = async (id) => {
			if (id !== 'sample') throw new Error('Unexpected catalogue provider')
			return {
				models: [
					{ id: 'one', label: 'One' },
					{ id: 'two', label: 'Two' },
				],
				notice: null,
			}
		}
		function Fixture() {
			const [choice, setChoice] = React.useState({ provider: 'sample', model: 'one' })
			const [effort, setEffort] = React.useState(undefined)
			return React.createElement(ModelPicker, {
				projectId: 'fixture-project',
				sessionId: 'fixture-session',
				providers: {
					available: [{ id: 'sample', label: 'Sample', defaultModel: 'one' }],
					selected: { id: choice.provider, model: choice.model },
				},
				choice,
				disabled: false,
				onChange: setChoice,
				loadCatalogue: catalogue,
				catalogueHarnessScope: 'namzu',
				settings: { effortLevels: ['low', 'medium', 'high'], effortDefault: 'medium' },
				effort,
				onEffortChange: setEffort,
			})
		}
		createRoot(host).render(React.createElement(Fixture))
	})
	const trigger = page.getByRole('button', { name: 'Select model', exact: true })
	const popup = page.locator('.model-picker-popup')
	const effortPopup = page.locator('.model-picker-effort-popup')
	const open = async () => {
		await trigger.click()
		await expect(popup).toHaveAttribute('data-open', '')
	}
	const outerClosed = async () => {
		await expect(trigger).toHaveAttribute('aria-expanded', 'false')
		await expect(popup).toHaveCount(0)
		await expect(trigger).toBeFocused()
	}

	await open()
	await popup.getByRole('radio', { name: 'Sample Two', exact: true }).click()
	await expect(popup.getByRole('radio', { name: 'Sample Two', exact: true })).toBeFocused()
	await expect(popup).toHaveAttribute('data-open', '')
	await page.keyboard.press('Escape')
	await outerClosed()
	receipt.checks.push('Escape closes outer popup after changing the selected model with effort available')

	await open()
	await popup.getByRole('button', { name: 'Reasoning effort', exact: true }).click()
	await expect(effortPopup).toHaveAttribute('data-open', '')
	await page.keyboard.press('Escape')
	await expect(effortPopup).toHaveCount(0)
	await expect(popup).toHaveAttribute('data-open', '')
	assert.equal(await trigger.getAttribute('aria-expanded'), 'true')
	receipt.checks.push('First Escape closes only the nested effort popup')
	await page.keyboard.press('Escape')
	await outerClosed()
	receipt.checks.push('Second Escape closes the outer popup and returns focus')

	await open()
	await page.keyboard.press('Escape')
	await outerClosed()
	receipt.checks.push('Plain Escape remains functional')
	assert.deepEqual(errors, [])
	receipt.passed = true
} finally {
	if (browser) await browser.close()
	await server.close()
	await mkdir(artifacts, { recursive: true })
	await writeFile(
		join(artifacts, 'model-picker-escape-browser-proof.json'),
		`${JSON.stringify(receipt, null, 2)}\n`,
	)
}
if (!receipt.passed) process.exitCode = 1
