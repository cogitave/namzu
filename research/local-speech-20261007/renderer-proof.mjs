/** Real Desktop renderer + Web Audio, synthetic local speech only. No native/model/download calls. */
import assert from 'node:assert/strict'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const { chromium, expect } = require('@playwright/test')
const artifacts = join(repo, 'research/local-speech-20261007/artifacts')
await mkdir(artifacts, { recursive: true })
const server = await createServer({ root: join(repo, 'packages/desktop'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false }, logLevel: 'error' })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const receipt = { passed: false, realDesktopRenderer: true, realWebAudio: true, syntheticSpeechApi: true, nativeActions: 0, modelRequests: 0, installations: 0, checks: [], screenshots: [], pageErrors: [] }

function installFixture({ appearance }) {
	localStorage.setItem('namzu.appearance', appearance)
	localStorage.setItem('namzu.sidebar-collapsed', 'true')
	let api
	const listeners = new Set()
	const speechListeners = new Set()
	const calls = { installs: 0, configures: [], speaks: [], cancels: [], acknowledges: [] }
	let active
	const state = {
		settings: { enabled: false, language: 'tr', engine: 'ema-lightning', idleUnloadSeconds: 300 },
		installation: 'missing', worker: 'unloaded', device: 'cpu',
		resources: { modelDownloadBytes: 34_389_147, runtimeDownloadBytes: null, diskBytes: null, ramBytes: null, cpuPercent: null, vramBytes: null, firstAudioMs: null, measuredAt: null },
	}
	const workspace = { windowId: 'voice-window', sequence: 0, homeGroupId: 'voice-group', layout: { version: 1, revision: 0, windows: [{ id: 'voice-window', focusedGroupId: 'voice-group', root: { kind: 'group', id: 'voice-group', tabs: ['sample-thread-1'], activeTabId: 'sample-thread-1' } }] } }
	const emit = event => { for (const listener of speechListeners) listener(event) }
	const pcm = new Uint8Array(4_800 * 2)
	const view = new DataView(pcm.buffer)
	for (let i = 0; i < 4_800; i++) view.setInt16(i * 2, Math.round(Math.sin(i * Math.PI * 2 * 220 / 24_000) * 500), true)
	const pcmBase64 = btoa(String.fromCharCode(...pcm))
	function frame(request) {
		if (active !== request) return
		emit({ type: 'audio', requestId: request.requestId, sequence: request.sequence++, sampleRate: 24_000, channels: 1, format: 'pcm_s16le', pcmBase64 })
	}
	Object.defineProperty(window, 'namzu', { configurable: true, get: () => api, set(value) {
		api = value
		const base = { ...value }
		api.workspace = async () => structuredClone(workspace)
		api.workspaceAction = async action => {
			const group = workspace.layout.windows[0].root
			if (action.kind === 'open' || action.kind === 'activate') {
				if (!group.tabs.includes(action.tabId)) group.tabs.push(action.tabId)
				group.activeTabId = action.tabId
			} else if (action.kind === 'close') {
				group.tabs = group.tabs.filter(id => id !== action.tabId)
				if (group.activeTabId === action.tabId) group.activeTabId = group.tabs.at(-1) ?? ''
			}
			workspace.sequence++
			workspace.layout.revision++
			return structuredClone(workspace)
		}
		api.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
		for (const name of ['draft', 'saveDraft', 'attachments', 'draftSettings', 'saveDraftSettings'])
			api[name] = (owner, ...args) => base[name](owner.replace(/:workspace:.*$/, ''), ...args)
		api.localSpeechState = async () => structuredClone(state)
		api.localSpeechConfigure = async change => {
			calls.configures.push(structuredClone(change)); Object.assign(state.settings, change)
			emit({ type: 'state', state: structuredClone(state) }); return structuredClone(state)
		}
		api.localSpeechInstall = async () => {
			calls.installs++
			state.installation = 'ready'
			state.resources.runtimeDownloadBytes = 81_000_000
			state.resources.diskBytes = 140_000_000
			emit({ type: 'state', state: structuredClone(state) }); return structuredClone(state)
		}
		api.localSpeechSpeak = async input => {
			if (active) emit({ type: 'end', requestId: active.requestId, reason: 'cancelled' })
			calls.speaks.push(structuredClone(input))
			active = { requestId: input.requestId, sequence: 0 }
			const request = active
			state.worker = 'speaking'
			queueMicrotask(() => { frame(request); frame(request) })
			return { requestId: input.requestId }
		}
		api.localSpeechCancel = async requestId => {
			calls.cancels.push(requestId)
			if (active?.requestId !== requestId) return
			active = undefined; state.worker = 'ready'
			emit({ type: 'end', requestId, reason: 'cancelled' })
		}
		api.localSpeechAcknowledge = async (requestId, sequence) => {
			calls.acknowledges.push({ requestId, sequence })
			if (active?.requestId === requestId) queueMicrotask(() => frame(active))
		}
		api.onLocalSpeechEvent = listener => { speechListeners.add(listener); return () => speechListeners.delete(listener) }
		for (const name of ['send', 'startPalComputer', 'stopPalComputer', 'cancel'])
			api[name] = async () => { throw new Error('Native/model action forbidden in voice renderer proof.') }
		window.__speechProof = {
			calls: () => structuredClone(calls),
			fail() { if (active) { const requestId = active.requestId; active = undefined; emit({ type: 'error', requestId, message: 'Synthetic voice playback failed.' }) } },
			split() {
				workspace.layout.windows[0].root = {
					kind: 'split', id: 'voice-split', direction: 'horizontal', ratio: 0.5,
					first: { kind: 'group', id: 'voice-group', tabs: ['sample-thread-2'], activeTabId: 'sample-thread-2' },
					second: { kind: 'group', id: 'voice-second', tabs: ['sample-thread-1'], activeTabId: 'sample-thread-1' },
				}
				workspace.sequence++; workspace.layout.revision++
				for (const listener of listeners) listener({ kind: 'workspace', view: structuredClone(workspace) })
			},
		}
	} })
}

async function popupFits(page, popup) {
	await page.evaluate(async () => {
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))
	})
	const box = await popup.boundingBox()
	const viewport = page.viewportSize()
	assert.ok(box && viewport)
	if (box.x + box.width > viewport.width + 1) {
		await page.screenshot({ path: join(artifacts, 'popup-layout-diagnostic.png') })
		console.log(JSON.stringify(await popup.evaluate(element => ({ popupStyle: element.getAttribute('style'), popup: element.getBoundingClientRect().toJSON(), positioner: element.parentElement?.getBoundingClientRect().toJSON(), positionerStyle: element.parentElement?.getAttribute('style'), availableWidth: getComputedStyle(element).getPropertyValue('--available-width'), viewport: innerWidth, documentWidth: document.documentElement.scrollWidth, trigger: document.querySelector('[aria-label="Voice settings"]')?.getBoundingClientRect().toJSON() }))))
	}
	assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, JSON.stringify({ box, viewport }))
	assert.equal(await popup.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true)
}

const cases = [
	{ name: 'wide-dark', appearance: 'dark', viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' },
	{ name: 'narrow-light', appearance: 'light', viewport: { width: 640, height: 720 }, reducedMotion: 'reduce' },
	{ name: 'small-dark', appearance: 'dark', viewport: { width: 390, height: 640 }, reducedMotion: 'reduce' },
]
let context
try {
	for (const scenario of cases) {
		context = await browser.newContext({ viewport: scenario.viewport, colorScheme: scenario.appearance, reducedMotion: scenario.reducedMotion })
		await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
		const page = await context.newPage()
		page.setDefaultTimeout(12_000)
		page.on('pageerror', error => receipt.pageErrors.push({ scenario: scenario.name, message: error.message }))
		await page.addInitScript(installFixture, { appearance: scenario.appearance })
		await page.goto(origin)
		await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
		await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEnabled()
		await page.getByRole('button', { name: 'Voice settings', exact: true }).click()
		const popup = page.getByRole('dialog', { name: 'Voice settings', exact: true })
		await expect(popup).toBeVisible()
		await popupFits(page, popup)
		const moreResources = popup.getByRole('button', { name: 'More resources', exact: true })
		await moreResources.click()
		await expect(popup.getByText('Not measured', { exact: true })).toHaveCount(5)
		await expect(popup.getByText('32.8 MiB', { exact: true })).toBeVisible()
		await expect(popup.getByRole('combobox', { name: 'Speech language', exact: true })).toBeEnabled()
		await popup.getByRole('combobox', { name: 'Speech language', exact: true }).click()
		await expect(page.getByRole('option', { name: 'Türkçe · Turkish', exact: true })).toBeVisible()
		await page.keyboard.press('Escape')
		await expect(popup).toBeVisible()
		await popup.getByRole('button', { name: 'Download voice', exact: true }).click()
		await expect(popup.getByRole('button', { name: 'Preview voice', exact: true })).toBeEnabled()
		assert.equal((await page.evaluate(() => window.__speechProof.calls())).installs, 1)
		assert.equal((await page.evaluate(() => window.__speechProof.calls())).speaks.length, 0)
		await popup.getByRole('button', { name: 'Preview voice', exact: true }).click()
		await expect(popup.getByRole('button', { name: 'Stop preview', exact: true })).toBeVisible()
		await expect.poll(async () => (await page.evaluate(() => window.__speechProof.calls())).acknowledges.length).toBeGreaterThan(0)
		await popup.getByRole('button', { name: 'Stop preview', exact: true }).click()
		await expect(popup.getByRole('button', { name: 'Preview voice', exact: true })).toBeVisible()
		const call = (await page.evaluate(() => window.__speechProof.calls())).speaks[0]
		assert.equal(call.text, 'Merhaba! Ben Namzu. Türkçe seslendirme bu cihazda çalışıyor.')
		assert.equal(call.sessionId, undefined)
		if (await moreResources.getAttribute('aria-expanded') === 'true') await moreResources.click()
		await expect(moreResources).toHaveAttribute('aria-expanded', 'false')
		await popupFits(page, popup)
		const imageName = `voice-settings-${scenario.name}.png`
		await page.screenshot({ path: join(artifacts, imageName) })
		receipt.screenshots.push(imageName)
		if (scenario.reducedMotion === 'reduce') assert.equal(await popup.evaluate(element => getComputedStyle(element).transitionDuration), '0s')
		receipt.checks.push(`${scenario.name}: actual settings popup fits; Turkish picker keyboard dismissal works; unknown resources remain unknown; explicit synthetic install; real Web Audio source-end acknowledgement; fixed preview cancels`)
		if (scenario.name === 'wide-dark') {
			await popup.getByRole('checkbox', { name: 'Enable voice', exact: true }).check()
			await page.keyboard.press('Escape')
			await expect(popup).not.toBeVisible()
			const read = page.getByRole('button', { name: 'Read aloud', exact: true }).first()
			await expect(read).toBeVisible()
			await read.click()
			await expect(page.getByRole('button', { name: 'Stop reading aloud', exact: true })).toBeVisible()
			await page.evaluate(() => window.__speechProof.fail())
			await expect(page.getByText('Synthetic voice playback failed.', { exact: true })).toBeVisible()
			await page.getByRole('button', { name: 'Read aloud', exact: true }).first().click()
			await expect(page.getByRole('button', { name: 'Stop reading aloud', exact: true })).toBeVisible()
			const before = (await page.evaluate(() => window.__speechProof.calls())).cancels.length
			await page.keyboard.press('Control+b')
			await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Polish empty states', exact: true }).click()
			await expect(page.getByRole('button', { name: 'Stop reading aloud', exact: true })).toHaveCount(0)
			await expect.poll(async () => (await page.evaluate(() => window.__speechProof.calls())).cancels.length).toBeGreaterThan(before)
			receipt.checks.push('Actual settled assistant message read aloud, closed-settings error visibility, and owner-switch cancellation')
			await page.evaluate(() => window.__speechProof.split())
			await expect(page.getByRole('button', { name: 'Voice settings', exact: true })).toHaveCount(2)
			await page.locator('[data-workspace-group="voice-group"]').getByRole('button', { name: 'Voice settings', exact: true }).click()
			const firstLabel = await page.getByRole('combobox', { name: 'Speech language', exact: true }).getAttribute('aria-labelledby')
			await page.keyboard.press('Escape')
			await page.locator('[data-workspace-group="voice-second"]').getByRole('button', { name: 'Voice settings', exact: true }).click()
			const secondLabel = await page.getByRole('combobox', { name: 'Speech language', exact: true }).getAttribute('aria-labelledby')
			assert.ok(firstLabel && secondLabel && firstLabel !== secondLabel)
			assert.equal(await page.evaluate(id => [...document.querySelectorAll('[id]')].filter(element => element.id === id).length, secondLabel), 1)
			receipt.checks.push('Actual sibling split panes retain unique speech-language label identities')
		}
		await context.close(); context = undefined
	}
	assert.deepEqual(receipt.pageErrors, [])
	receipt.passed = true
	await unlink(join(artifacts, 'popup-layout-diagnostic.png')).catch(error => { if (error.code !== 'ENOENT') throw error })
} finally {
	await context?.close()
	await browser.close()
	await server.close()
	await writeFile(join(artifacts, 'renderer-proof.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
if (!receipt.passed) process.exitCode = 1
console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, pageErrors: receipt.pageErrors.length }))
