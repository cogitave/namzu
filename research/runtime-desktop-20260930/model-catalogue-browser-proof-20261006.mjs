/** Sample-only real Chromium popup proof; native, provider and model transports are never used. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/preview'
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1100, height: 800 } })
const page = await context.newPage()
page.setDefaultTimeout(12000)
const faults = []
page.on('pageerror', (error) => faults.push(error.message))
await context.route('**/*', (route) =>
	new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort(),
)
await mkdir(artifacts, { recursive: true })
const receipt = {
	passed: false,
	realBrowserPopup: true,
	isolation: 'Vite design preview with a synthetic models method',
	nativeActions: 0,
	inferenceRequests: 0,
	checks: [],
}
const control = (method, ...args) =>
	page.evaluate(({ method, args }) => window.__modelProof[method](...args), { method, args })
const calls = () => control('calls')
const trigger = page.getByRole('button', { name: 'Select model', exact: true })
const popup = page.locator('[aria-label="Model picker"]')
const row = (label) => popup.getByRole('radio', { name: `Sample ${label}`, exact: true })
const nativeRow = (provider, label) =>
	popup.getByRole('radio', { name: `${provider} ${label}`, exact: true })
const open = async () => {
	await trigger.click()
	await expect(popup).toBeVisible()
}
const close = async () => {
	await page.keyboard.press('Escape')
	await expect(popup).toHaveCount(0)
}

try {
	await page.goto(origin, { waitUntil: 'networkidle' })
	await page.getByRole('status', { name: 'Design preview', exact: true }).waitFor()
	await page.evaluate(async () => {
		const React = (await import('/node_modules/.vite/deps/react.js')).default
		const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
		const { ModelPicker } = await import('/src/renderer/model-picker.tsx')
		// Follow Vite's current HMR dependency URL so the proof invalidates the
		// exact module instance imported by ModelPicker, even after source edits.
		const transformed = await (await fetch('/src/renderer/model-picker.tsx')).text()
		const cacheSpecifier = transformed.match(
			/from "([^"]*model-catalogue-display-cache[^"]*)"/,
		)?.[1]
		if (!cacheSpecifier) throw new Error('Vite did not expose the model picker cache dependency')
		const { invalidateModelCatalogueDisplayCache, modelCatalogueDisplayCacheForApi } =
			await import(cacheSpecifier)
		const api = window.namzu
		const cache = modelCatalogueDisplayCacheForApi(api)
		const actualNow = Date.now.bind(Date)
		let clockOffset = 0
		Date.now = () => actualNow() + clockOffset
		const state = {
			calls: [], plans: [], gates: [], setSession: () => {}, setHarness: () => {},
			setProviderKind: () => {}, setChoice: () => {},
		}
		api.models = async (projectId, provider, sessionId) => {
			if (projectId !== 'fixture-project' || !['sample', 'codex-cli', 'claude-code'].includes(provider))
				throw new Error('Foreign fixture catalogue request')
			const index = state.calls.push({ projectId, provider, sessionId }) - 1
			if (provider !== 'sample') {
				const prefix = provider === 'codex-cli' ? 'Codex' : 'Claude'
				return { models: [
					{ id: 'native-a', label: `${prefix} A` },
					{ id: 'native-b', label: `${prefix} B` },
				], notice: null }
			}
			const plan = state.plans.shift() ?? { kind: 'value', label: 'Known A' }
			if (plan.kind === 'hold')
				return new Promise((resolve, reject) => {
					state.gates.push({ index, resolve, reject })
				})
			if (plan.kind === 'fail') throw new Error('Private fixture error')
			return { models: [{ id: 'model', label: plan.label }], notice: null }
		}
		window.__modelProof = {
			calls: () => structuredClone(state.calls),
			planValue: (label) => state.plans.push({ kind: 'value', label }),
			holdNext: () => state.plans.push({ kind: 'hold' }),
			failNext: () => state.plans.push({ kind: 'fail' }),
			gates: () => state.gates.length,
			release: (index, label) => {
				const gate = state.gates.find((candidate) => candidate.index === index)
				if (!gate) throw new Error('Unknown fixture gate')
				state.gates = state.gates.filter((candidate) => candidate !== gate)
				gate.resolve({ models: [{ id: 'model', label }], notice: null })
			},
			setSession: (value) => state.setSession(value),
			setHarness: (value) => state.setHarness(value),
			ackHarness: (value) => {
				invalidateModelCatalogueDisplayCache(api, 'fixture-project')
				state.setHarness(value)
				state.setProviderKind(value)
				state.setChoice({ provider: value, model: 'native-a' })
			},
			invalidate: () => invalidateModelCatalogueDisplayCache(api, 'fixture-project'),
			advanceClock: (milliseconds) => { clockOffset += milliseconds },
			primeEviction: async () => {
				for (let index = 0; index < 49; index++) {
					const key = cache.scope({
						projectId: 'fixture-project', sessionId: `evict-${index}`,
						provider: { id: 'sample', label: 'Sample', defaultModel: 'model' },
						available: [{ id: 'sample', label: 'Sample', defaultModel: 'model' }],
						harnessScope: 'namzu',
					})
					await cache.load(key, async () => ({
						models: [{ id: 'model', label: `Unshown ${index}` }], notice: null,
					}))
				}
			},
		}
		document.getElementById('root').style.display = 'none'
		const host = document.createElement('div')
		host.id = 'model-fixture'
		host.style.cssText = 'padding:300px 40px 0;min-height:700px;background:var(--background);'
		document.body.append(host)
		function Fixture() {
			const [sessionId, setSession] = React.useState('session-a')
			const [harnessScope, setHarness] = React.useState('namzu')
			const [providerKind, setProviderKind] = React.useState('sample')
			const [choice, setChoice] = React.useState({ provider: 'sample', model: 'model' })
			state.setSession = setSession
			state.setHarness = setHarness
			state.setProviderKind = setProviderKind
			state.setChoice = setChoice
			const label = providerKind === 'sample' ? 'Sample' :
				providerKind === 'codex-cli' ? 'Codex CLI' : 'Claude Code'
			return React.createElement(ModelPicker, {
				projectId: 'fixture-project', sessionId, catalogueHarnessScope: harnessScope,
				providers: {
					available: [{ id: providerKind, label, defaultModel: choice.model }],
					selected: { id: providerKind, model: choice.model },
				},
				choice, disabled: false, onChange: setChoice,
			})
		}
		createRoot(host).render(React.createElement(Fixture))
	})
	await trigger.waitFor()
	await open()
	await expect(row('Known A')).toBeVisible()
	assert.equal((await calls()).length, 1)
	await close()
	await open()
	await expect(row('Known A')).toBeVisible()
	assert.equal((await calls()).length, 1)
	assert.equal(await popup.getByText('Loading models…', { exact: true }).count(), 0)
	receipt.checks.push('reopen renders retained catalogue immediately without another model read')
	await close()
	await control('planValue', 'Session B')
	await control('setSession', 'session-b')
	await open()
	await expect(row('Session B')).toBeVisible()
	assert.equal((await calls()).length, 2)
	await close()
	await control('setSession', 'session-a')
	await open()
	await expect(row('Known A')).toBeVisible()
	assert.equal((await calls()).length, 2)
	receipt.checks.push('tab round trip isolates exact session and reuses only its own catalogue')
	await control('planValue', 'Codex scoped')
	await control('setHarness', 'codex-cli')
	await expect(row('Codex scoped')).toBeVisible()
	assert.equal((await calls()).length, 3)
	await control('setHarness', 'namzu')
	await expect(row('Known A')).toBeVisible()
	assert.equal((await calls()).length, 3)
	receipt.checks.push('harness metadata scope changes the catalogue without changing the model choice')
	await control('holdNext')
	await control('setHarness', 'claude-code')
	await page.waitForFunction(() => window.__modelProof.gates() === 1)
	const staleIndex = (await calls()).length - 1
	await control('planValue', 'Current engine')
	await control('setHarness', 'new-engine')
	await expect(row('Current engine')).toBeVisible()
	await control('release', staleIndex, `Stale engine ${'x'.repeat(300_000)}`)
	await expect(popup.getByText('Stale engine', { exact: false })).toHaveCount(0)
	await expect(row('Current engine')).toBeVisible()
	receipt.checks.push('late prior-engine result, including an uncached oversized result, cannot publish into the current popup')
	await close()
	await control('failNext')
	await control('setSession', 'session-error')
	await open()
	await expect(popup.getByRole('alert')).toContainText('Could not load these models')
	await control('planValue', 'Recovered')
	await popup.getByRole('button', { name: 'Retry Sample models', exact: true }).click()
	await expect(row('Recovered')).toBeVisible()
	receipt.checks.push('failed read stays generic and explicit Retry obtains a new catalogue')
	await control('planValue', 'Refreshed')
	await popup.getByRole('button', { name: 'Refresh Sample models', exact: true }).click()
	await expect(row('Refreshed')).toBeVisible()
	receipt.checks.push('explicit Refresh replaces a successful cached catalogue')
	await control('planValue', 'Rebound connection')
	await control('invalidate')
	await expect(row('Rebound connection')).toBeVisible()
	receipt.checks.push('project connection invalidation reloads an open popup and fences old display')
	await close()
	await control('advanceClock', 120_001)
	await control('planValue', 'After expiry')
	await open()
	await expect(row('After expiry')).toBeVisible()
	receipt.checks.push('a deterministic expired catalogue reloads on popup revisit')
	await close()
	await control('primeEviction')
	await control('planValue', 'After eviction')
	await open()
	await expect(row('After eviction')).toBeVisible()
	receipt.checks.push('an evicted provider catalogue reloads on popup revisit')
	await close()
	await control('ackHarness', 'codex-cli')
	await open()
	await expect(nativeRow('Codex CLI', 'Codex A')).toBeVisible()
	const nativeReadCount = (await calls()).length
	await nativeRow('Codex CLI', 'Codex B').click()
	await expect(trigger).toContainText('Codex B')
	await expect(popup).toHaveCount(0)
	await open()
	await expect(nativeRow('Codex CLI', 'Codex A')).toBeVisible()
	assert.equal((await calls()).length, nativeReadCount)
	assert.equal(await popup.getByText('Loading models…', { exact: true }).count(), 0)
	receipt.checks.push('native provider selected-model default echo does not refetch its one-provider popup catalogue')
	await close()
	await control('ackHarness', 'claude-code')
	await open()
	await expect(nativeRow('Claude Code', 'Claude A')).toBeVisible()
	assert.equal((await calls()).length, nativeReadCount + 1)
	await close()
	await control('ackHarness', 'codex-cli')
	await open()
	await expect(nativeRow('Codex CLI', 'Codex A')).toBeVisible()
	assert.equal((await calls()).length, nativeReadCount + 2)
	receipt.checks.push('acknowledged native engine changes invalidate retained rows and request the new engine catalogue')
	assert.deepEqual(faults, [])
	receipt.passed = true
} finally {
	await writeFile(join(artifacts, 'model-catalogue-browser-proof-20261006.json'), `${JSON.stringify(receipt, null, 2)}\n`)
	await browser.close()
}
assert.equal(receipt.passed, true)
console.log(JSON.stringify(receipt))
