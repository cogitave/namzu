/** Two isolated real React renderer pages, fixture events and images only. */
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
	realReactRenderer: true,
	isolatedPages: 2,
	nativeActions: 0,
	providerRequests: 0,
	checks: [],
	limitations: [
		'Synthetic Vite preview API and attachment events; no native IPC or device file read.',
		'The two pages are independent renderer fixtures, not an Electron multiwindow fanout proof.',
	],
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
	browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
	const contexts = []
	const pages = []
	const faults = []
	for (const holdFirst of [true, false]) {
		const context = await browser.newContext({
			viewport: { width: 1280, height: 850 },
			colorScheme: 'dark',
		})
		contexts.push(context)
		await context.route('**/*', (route) =>
			new URL(route.request().url()).origin === new URL(origin).origin
				? route.continue()
				: route.abort(),
		)
		const page = await context.newPage()
		pages.push(page)
		page.setDefaultTimeout(12000)
		page.on('pageerror', (error) => faults.push(error.message))
		await page.addInitScript((hold) => {
			let api
			const listeners = new Set()
			const imageData =
				'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBz8AAAAASUVORK5CYII='
			const files = {
				'sample-thread-1': {
					id: 'fixture-image-a', name: 'fixture-a.png', kind: 'image',
					size: 68, mediaType: 'image/png', preview: imageData,
				},
				'sample-thread-2': {
					id: 'fixture-image-b', name: 'fixture-b.png', kind: 'image',
					size: 68, mediaType: 'image/png', preview: imageData,
				},
			}
			const workspace = {
				windowId: `fixture-window-${hold ? 'held' : 'inactive'}`,
				sequence: 0,
				homeGroupId: 'fixture-group',
				layout: {
					version: 1, revision: 0,
					windows: [{ id: `fixture-window-${hold ? 'held' : 'inactive'}`,
						focusedGroupId: 'fixture-group',
						root: { kind: 'group', id: 'fixture-group', tabs: [], activeTabId: '' } }],
				},
			}
			const proof = {
				calls: [], held: hold, release: null,
				emit(event) {
					for (const listener of listeners) listener(structuredClone(event))
				},
				releaseHeld() {
					if (!this.release) throw new Error('No held fixture snapshot')
					this.release()
					this.release = null
				},
			}
			window.__attachmentRendererProof = proof
			Object.defineProperty(window, 'namzu', {
				configurable: true,
				get: () => api,
				set(value) {
					api = value
					const base = { ...value }
					api.workspace = async () => structuredClone(workspace)
					api.workspaceAction = async (action) => {
						const group = workspace.layout.windows[0].root
						if (action.kind === 'open' || action.kind === 'activate') {
							if (!group.tabs.includes(action.tabId)) group.tabs.push(action.tabId)
							group.activeTabId = action.tabId
						} else if (action.kind === 'close') {
							group.tabs = group.tabs.filter((id) => id !== action.tabId)
							if (group.activeTabId === action.tabId) group.activeTabId = group.tabs.at(-1) ?? ''
						}
						workspace.layout.revision++
						workspace.sequence++
						return structuredClone(workspace)
					}
					api.onEvent = (listener) => {
						listeners.add(listener)
						return () => listeners.delete(listener)
					}
					for (const name of ['draft', 'saveDraft', 'attachments', 'draftSettings', 'saveDraftSettings'])
						api[name] = (owner, ...args) =>
							base[name](owner.replace(/:workspace:.*$/, ''), ...args)
					api.openConversation = async (projectId, sessionId) => {
						await base.openConversation(projectId, sessionId)
						proof.calls.push(sessionId)
						if (!files[sessionId]) return base.openConversation(projectId, sessionId)
						const { emptyThread, restoreMessages } = await import('/src/shared/projection.ts')
						const messages = [
							{ role: 'user', text: `Fixture ${sessionId}`, attachments: [files[sessionId]] },
							{ role: 'assistant', text: 'Fixture answer' },
						]
						const thread = { ...restoreMessages(emptyThread(), messages), revision: 1 }
						if (proof.held && sessionId === 'sample-thread-1') {
							proof.held = false
							await new Promise((resolve) => { proof.release = resolve })
						}
						return { messages, partial: false, thread }
					}
					api.backgroundWorkStatuses = async () => ({})
					api.send = async () => { throw new Error('Fixture must never send a prompt') }
					api.startPalComputer = api.stopPalComputer = async () => {
						throw new Error('Fixture must never control a computer')
					}
				},
			})
		}, holdFirst)
		await page.goto(origin)
		await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
	}
	const [heldPage, inactivePage] = pages
	const openA = async (page) => {
		await page.locator('[data-project-group="sample-app"]')
			.getByRole('button', { name: 'Refine navigation', exact: true }).click()
	}
	const openB = async (page) => {
		await page.locator('[data-project-group="sample-app"]')
			.getByRole('button', { name: 'Polish empty states', exact: true }).click()
	}
	const emit = (page, event) =>
		page.evaluate((value) => window.__attachmentRendererProof.emit(value), event)
	const fallback = (page, name) =>
		page.locator('.normal-transcript .attachment-item').filter({ hasText: name })

	await openA(heldPage)
	await heldPage.waitForFunction(() => window.__attachmentRendererProof.release !== null)
	await emit(heldPage, {
		kind: 'attachment-previews-evicted', sessionId: 'sample-thread-1',
		attachmentIds: ['fixture-image-a'], revision: 2,
	})
	await heldPage.evaluate(() => window.__attachmentRendererProof.releaseHeld())
	await expect(fallback(heldPage, 'fixture-a.png')).toContainText('Preview unavailable')
	await expect(fallback(heldPage, 'fixture-a.png').getByRole('button', { name: 'Preview fixture-a.png' })).toHaveCount(0)
	assert.deepEqual(
		await heldPage.evaluate(() => window.__attachmentRendererProof.calls),
		['sample-thread-1'],
	)
	receipt.checks.push('Held stale history replays a revisioned eviction into the real App transcript')
	await openB(heldPage)
	const openImage = fallback(heldPage, 'fixture-b.png')
	await openImage.getByRole('button', { name: 'Preview fixture-b.png' }).click()
	await expect(heldPage.getByRole('dialog')).toContainText('fixture-b.png')
	await emit(heldPage, {
		kind: 'attachment-previews-evicted', sessionId: 'sample-thread-2',
		attachmentIds: ['fixture-image-b'], revision: 2,
	})
	await expect(heldPage.getByRole('dialog')).toHaveCount(0)
	await expect(openImage).toContainText('Preview unavailable')
	await expect(openImage).toBeFocused()
	receipt.dialogRetirementFocus = await heldPage.evaluate(() => ({
		tag: document.activeElement?.tagName,
		insideFallback: Boolean(document.activeElement?.closest('[data-attachment-id="fixture-image-b"]')),
		name: document.activeElement?.getAttribute('aria-label'),
	}))
	assert.equal(receipt.dialogRetirementFocus.insideFallback, true)
	receipt.checks.push('An open image dialog retires to the connected, named attachment fallback with focus')

	await openA(inactivePage)
	const activeA = fallback(inactivePage, 'fixture-a.png')
	await expect(activeA.getByRole('button', { name: 'Preview fixture-a.png' })).toBeVisible()
	await openB(inactivePage)
	await expect(fallback(inactivePage, 'fixture-b.png').getByRole('button', { name: 'Preview fixture-b.png' })).toBeVisible()
	await emit(inactivePage, {
		kind: 'attachment-previews-evicted', sessionId: 'sample-thread-1',
		attachmentIds: ['fixture-image-a'], revision: 2,
	})
	await openA(inactivePage)
	await expect(fallback(inactivePage, 'fixture-a.png')).toContainText('Preview unavailable')
	await expect(fallback(inactivePage, 'fixture-a.png').getByRole('button', { name: 'Preview fixture-a.png' })).toHaveCount(0)
	receipt.inactiveOpenReads = await inactivePage.evaluate(() => window.__attachmentRendererProof.calls)
	receipt.checks.push('An inactive ordinary owner loses only its cached image preview; metadata remains on revisit')

	await openB(inactivePage)
	const b = fallback(inactivePage, 'fixture-b.png')
	await b.getByRole('button', { name: 'Preview fixture-b.png' }).click()
	await expect(inactivePage.getByRole('dialog')).toContainText('fixture-b.png')
	await inactivePage.getByRole('button', { name: 'Close image preview' }).click()
	await expect(inactivePage.getByRole('dialog')).toHaveCount(0)
	await expect(b.getByRole('button', { name: 'Preview fixture-b.png' })).toBeFocused()
	receipt.checks.push('Closing a still available image returns focus to its preview button')
	await openA(inactivePage)
	const composer = inactivePage.getByRole('textbox', { name: 'Message Namzu', exact: true })
	await composer.focus()
	await emit(inactivePage, {
		kind: 'attachment-previews-evicted', sessionId: 'sample-thread-2',
		attachmentIds: ['fixture-image-b'], revision: 2,
	})
	await expect(composer).toBeFocused()
	await openB(inactivePage)
	await expect(fallback(inactivePage, 'fixture-b.png')).toContainText('Preview unavailable')
	receipt.checks.push('Retiring a closed image in an inactive owner does not steal composer focus')
	await emit(inactivePage, {
		kind: 'prompt', sessionId: 'sample-thread-2', prompt: 'Keyboard image fixture', revision: 3,
		attachments: [{
			id: 'fixture-image-c', name: 'fixture-c.png', kind: 'image', size: 68,
			mediaType: 'image/png',
			preview: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBz8AAAAASUVORK5CYII=',
		}],
	})
	const keyboardImage = fallback(inactivePage, 'fixture-c.png')
	const keyboardTrigger = keyboardImage.getByRole('button', { name: 'Preview fixture-c.png' })
	await keyboardTrigger.focus()
	await inactivePage.keyboard.press('Enter')
	await expect(inactivePage.getByRole('dialog')).toContainText('fixture-c.png')
	await emit(inactivePage, {
		kind: 'attachment-previews-evicted', sessionId: 'sample-thread-2',
		attachmentIds: ['fixture-image-c'], revision: 4,
	})
	await expect(inactivePage.getByRole('dialog')).toHaveCount(0)
	await expect(keyboardImage).toBeFocused()
	receipt.keyboardRetirementFocus = await keyboardImage.evaluate((row) => {
		const style = getComputedStyle(row)
		return {
			focusVisible: row.matches(':focus-visible'),
			outlineStyle: style.outlineStyle,
			outlineWidth: style.outlineWidth,
			outlineColor: style.outlineColor,
		}
	})
	assert.equal(receipt.keyboardRetirementFocus.focusVisible, true)
	assert.notEqual(receipt.keyboardRetirementFocus.outlineStyle, 'none')
	assert.ok(Number.parseFloat(receipt.keyboardRetirementFocus.outlineWidth) > 0)
	await inactivePage.screenshot({
		path: join(artifacts, 'attachment-preview-retired-fallback-keyboard-browser-20261007.png'),
	})
	receipt.checks.push('Keyboard-open image retirement preserves a visible focus outline on the named fallback')
	assert.deepEqual(faults, [])
	receipt.passed =
		receipt.dialogRetirementFocus.insideFallback === true &&
		receipt.keyboardRetirementFocus.focusVisible === true
} finally {
	if (browser) await browser.close()
	await server.close()
	await mkdir(artifacts, { recursive: true })
	await writeFile(
		join(artifacts, 'attachment-preview-renderer-keyboard-browser-proof-20261007.json'),
		`${JSON.stringify(receipt, null, 2)}\n`,
	)
}
if (!receipt.passed) process.exitCode = 1
