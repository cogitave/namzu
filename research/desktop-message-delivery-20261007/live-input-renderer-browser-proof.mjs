/** Isolated real React renderer proof; synthetic local API, no native or model calls. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const { chromium, expect } = require('@playwright/test')
const server = await createServer({
	root: join(repo, 'packages/desktop'),
	server: { host: '127.0.0.1', port: 0 },
	logLevel: 'error',
})
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const artifacts = join(repo, 'research/desktop-message-delivery-20261007/artifacts')
await mkdir(artifacts, { recursive: true })
const receipt = {
	passed: false,
	realRenderer: true,
	syntheticApi: true,
	nativeActions: 0,
	modelRequests: 0,
	checks: [],
	pageErrors: [],
}

function installFixture() {
	let api
	const listeners = new Set()
	const currentCalls = []
	const queueCalls = []
	let supported = false
	const workspace = {
		windowId: 'live-window', sequence: 0, homeGroupId: 'live-group',
		layout: { version: 1, revision: 0, windows: [{
			id: 'live-window', focusedGroupId: 'live-group',
			root: { kind: 'group', id: 'live-group', tabs: [], activeTabId: '' },
		}] },
	}
	const owner = id => id.replace(/:workspace:.*$/, '')
	const emit = event => { for (const listener of listeners) listener(event) }
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
		for (const name of ['draft', 'attachments', 'draftSettings', 'saveDraftSettings'])
			api[name] = (id, ...args) => base[name](owner(id), ...args)
		api.saveDraft = (id, text) => base.saveDraft(owner(id), text)
		api.openConversation = async (projectId, id) => {
			await base.openConversation(projectId, id)
			return { messages: [], partial: false }
		}
		api.sendCurrent = async (id, prompt) => {
			if (!supported) throw Error('Unsupported fixture live input')
			await base.draft(owner(id))
			currentCalls.push({ id, prompt })
			emit({ kind: 'live-input', sessionId: id, inputId: `input-${currentCalls.length}`, prompt, status: 'unknown' })
			if (await base.draft(owner(id)) === prompt) await base.saveDraft(owner(id), '')
			emit({ kind: 'live-input', sessionId: id, inputId: `input-${currentCalls.length}`, prompt, status: 'pending' })
			return 'accepted'
		}
		api.send = async (id, prompt) => {
			await base.draft(owner(id))
			queueCalls.push({ id, prompt })
			if (await base.draft(owner(id)) === prompt) await base.saveDraft(owner(id), '')
			emit({ kind: 'state', sessionId: id, running: true, liveInputSupported: supported,
				queued: queueCalls.map(item => item.prompt), queuedItems: [] })
		}
		for (const name of ['startPalComputer', 'stopPalComputer', 'cancel', 'readJob', 'stopJob'])
			api[name] = async () => { throw Error('Native or provider action forbidden in browser proof') }
		window.__liveProof = {
			setSupported: value => {
				supported = value
				emit({ kind: 'state', sessionId: 'sample-thread-1', running: true,
					liveInputSupported: value, queued: queueCalls.map(item => item.prompt), queuedItems: [] })
			},
			deliver: () => {
				const item = currentCalls.at(-1)
				emit({ kind: 'live-input', sessionId: item.id, inputId: `input-${currentCalls.length}`,
					prompt: item.prompt, status: 'delivered' })
			},
			counts: () => ({ current: currentCalls.length, queued: queueCalls.length }),
			saved: () => base.draft('sample-thread-1'),
		}
	} })
}

let context
try {
	context = await browser.newContext({
		viewport: { width: 860, height: 580 },
		reducedMotion: 'reduce',
		colorScheme: 'dark',
	})
	await context.route('**/*', route =>
		new URL(route.request().url()).origin === new URL(origin).origin
			? route.continue()
			: route.abort())
	const page = await context.newPage()
	page.setDefaultTimeout(12000)
	page.on('pageerror', error => receipt.pageErrors.push(error.message))
	await page.addInitScript(installFixture)
	await page.goto(origin)
	await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
	await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
	const editor = page.getByRole('textbox', { name: 'Message Namzu', exact: true })
	await expect(editor).toBeEnabled()
	await page.evaluate(() => window.__liveProof.setSupported(true))
	await expect(page.getByRole('button', { name: 'Send to current turn', exact: true })).toHaveCount(0)
	await editor.fill('Synthetic live direction')
	await expect(page.getByRole('button', { name: 'Send to current turn', exact: true })).toBeEnabled()
	await page.getByRole('button', { name: 'Send to current turn', exact: true }).click()
	await expect(editor).toHaveValue('')
	await expect(page.getByText('1 sending to this turn', { exact: false })).toBeVisible()
	assert.deepEqual(await page.evaluate(() => window.__liveProof.counts()), { current: 1, queued: 0 })
	assert.equal(await page.evaluate(() => window.__liveProof.saved()), '')
	receipt.checks.push('Supported ordinary Namzu busy send uses current turn, keeps queue empty and clears the accepted draft')
	await page.evaluate(() => window.__liveProof.deliver())
	await expect(page.getByText('1 delivered', { exact: false })).toBeVisible()
	await expect(page.getByText('Synthetic live direction', { exact: true })).toBeVisible()
	receipt.checks.push('Delivery confirmation appears separately from acceptance and renders one user row')
	await editor.fill('Synthetic explicit next turn')
	await page.getByRole('button', { name: 'Queue for next turn', exact: true }).click()
	await expect(page.getByText('1 queued', { exact: false })).toBeVisible()
	assert.deepEqual(await page.evaluate(() => window.__liveProof.counts()), { current: 1, queued: 1 })
	receipt.checks.push('Explicit Queue action bypasses current-turn input')
	await page.evaluate(() => window.__liveProof.setSupported(false))
	await editor.fill('Synthetic unsupported delivery')
	await expect(page.getByRole('button', { name: 'Queue message', exact: true })).toBeEnabled()
	await page.getByRole('button', { name: 'Queue message', exact: true }).click()
	assert.deepEqual(await page.evaluate(() => window.__liveProof.counts()), { current: 1, queued: 2 })
	receipt.checks.push('Unsupported runtime retains the next-turn queue path in reduced-motion short viewport')
	assert.deepEqual(receipt.pageErrors, [])
	receipt.passed = true
} finally {
	await context?.close()
	await browser.close()
	await server.close()
	await writeFile(join(artifacts, 'live-input-renderer-browser-proof.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
if (!receipt.passed) process.exitCode = 1
