/** Real Pal card in an isolated design preview; computer actions are memory stubs only. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5199/preview'
assert.equal(new URL(origin).pathname, '/preview', 'This proof requires the isolated design preview.')
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const receipt = join(artifacts, 'pal-computer-status-browser-20261006.json')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1188, height: 900 }, colorScheme: 'dark' })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const faults = []
const externalRequests = []
const measurements = []
const screenshots = []
page.on('pageerror', (error) => faults.push(error.message))
await context.route('**/*', (route) => {
	const url = new URL(route.request().url())
	if (url.origin === new URL(origin).origin) return route.continue()
	externalRequests.push(url.origin)
	return route.abort()
})
await mkdir(artifacts, { recursive: true })

async function settleMotion(element) {
	await element.evaluate(async (target) => {
		await document.fonts.ready
		await Promise.all(target.getAnimations({ subtree: true }).filter((animation) => {
			const end = animation.effect?.getComputedTiming().endTime
			return animation.playState === 'running' && typeof end === 'number' && Number.isFinite(end)
		}).map((animation) => animation.finished.catch(() => {})))
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	})
}
async function inspect(name, card, action) {
	await settleMotion(card)
	const state = await card.evaluate((element) => {
		const button = element.querySelector('.pal-computer-action')
		const box = (target) => {
			const rect = target.getBoundingClientRect()
			return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
		}
		return {
			viewport: { width: innerWidth, height: innerHeight },
			card: box(element),
			entry: box(element.querySelector('.pal-computer-entry')),
			footerCount: element.querySelectorAll('.pal-computer-actions').length,
			documentOverflow: document.documentElement.scrollWidth > innerWidth,
			action: button ? {
				label: button.getAttribute('aria-label'), disabled: button.disabled,
				box: box(button), focusVisible: button.matches(':focus-visible'),
				rest: button.querySelector('.pal-status-rest').textContent,
				hover: button.querySelector('.pal-status-hover').textContent,
				restOpacity: Number(getComputedStyle(button.querySelector('.pal-status-rest')).opacity),
				hoverOpacity: Number(getComputedStyle(button.querySelector('.pal-status-hover')).opacity),
				pointerEvents: getComputedStyle(button).pointerEvents,
			} : null,
		}
	})
	assert.equal(state.footerCount, 0, 'The card must have no separate lifecycle action footer.')
	assert.equal(state.documentOverflow, false, 'The card must not cause horizontal viewport overflow.')
	if (action) assert.equal(state.action?.label, action)
	measurements.push({ name, ...state })
	return state
}
function sameBounds(first, next) {
	for (const key of ['x', 'y', 'width', 'height'])
		assert.ok(Math.abs(first[key] - next[key]) < 0.5, `Status target ${key} moved during reveal.`)
}
async function capture(card, name) {
	await settleMotion(card)
	const filename = `pal-computer-status-${name}-20261006.png`
	await card.screenshot({ path: join(artifacts, filename) })
	screenshots.push(filename)
}

try {
	await page.addInitScript(() => {
		let api
		const listeners = new Set()
		const state = {
			computer: { status: 'stopped' }, statusReads: 0, screenReads: 0,
			starts: [], stops: [], modelRequests: 0, sessionId: '', projectId: '',
			startPending: false,
		}
		const workspace = {
			windowId: 'fixture-window', sequence: 0, homeGroupId: 'fixture-group',
			layout: { version: 1, revision: 0, windows: [{
				id: 'fixture-window', focusedGroupId: 'fixture-group',
				root: { kind: 'group', id: 'fixture-group', tabs: [], activeTabId: '' },
			}] },
		}
		Object.defineProperty(window, 'namzu', {
			configurable: true,
			get: () => api,
			set(value) {
				api = value
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
				api.onEvent = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
				const newConversation = api.newConversation.bind(api)
				api.newConversation = async (projectId) => {
					const result = await newConversation(projectId)
					const owner = (await api.projects()).find((project) => project.id === projectId)
					if (owner?.palId) {
						state.sessionId = result.id
						state.projectId = projectId
					}
					return result
				}
				api.palComputer = async () => { state.statusReads++; return structuredClone(state.computer) }
				api.palScreen = async () => {
					state.screenReads++
					return { source: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', width: 1, height: 1 }
				}
				api.startPalComputer = async (id) => {
					state.starts.push(id)
					state.startPending = true
					return new Promise((resolve) => {
						state.releaseStart = () => {
							state.computer = { status: 'ready', generation: 'fixture-generation-1', environmentId: 'memory-fixture' }
							state.startPending = false
							resolve(structuredClone(state.computer))
							delete state.releaseStart
						}
					})
				}
				api.stopPalComputer = async (id) => {
					state.stops.push(id)
					state.computer = { status: 'stopped' }
					return structuredClone(state.computer)
				}
				api.send = async () => { state.modelRequests++; throw new Error('This UI proof forbids model requests.') }
				window.__palComputerStatusProof = {
					state,
					setComputer(computer) {
						state.computer = computer
						document.dispatchEvent(new Event('visibilitychange'))
					},
					emit(event) { for (const listener of listeners) listener(event) },
				}
			},
		})
	})
	await page.goto(origin)
	await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
	await page.getByRole('button', { name: 'Create your first Pal', exact: true }).click()
	await page.locator('.pal-welcome').getByRole('button', { name: 'Customize your Pal', exact: true }).click()
	const customize = page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
	await customize.getByRole('textbox', { name: 'Pal name', exact: true }).fill('Sıtkı')
	await customize.getByRole('button', { name: 'Save', exact: true }).click()
	await expect(customize).toHaveCount(0)
	const card = page.getByRole('complementary', { name: 'Pal context', exact: true })
	await expect(card).toBeVisible()
	const action = card.locator('.pal-computer-action')
	const open = card.getByRole('button', { name: 'Open Sıtkı’s computer', exact: true })
	await expect(action).toHaveAttribute('aria-label', 'Start computer')
	await page.mouse.move(1, 1)
	const rest = await inspect('offline-rest', card, 'Start computer')
	assert.equal(rest.action.rest, 'Offline')
	assert.equal(rest.action.restOpacity, 1)
	assert.equal(rest.action.hoverOpacity, 0)
	await capture(card, 'offline-rest')
	await action.hover()
	const hovered = await inspect('offline-hover', card, 'Start computer')
	assert.equal(hovered.action.restOpacity, 0)
	assert.equal(hovered.action.hoverOpacity, 1)
	sameBounds(rest.action.box, hovered.action.box)
	await capture(card, 'offline-hover')
	await page.mouse.move(1, 1)
	await open.focus()
	await page.keyboard.press('Tab')
	await expect(action).toBeFocused()
	const keyboard = await inspect('offline-keyboard', card, 'Start computer')
	assert.equal(keyboard.action.focusVisible, true)
	assert.equal(keyboard.action.hoverOpacity, 1)
	sameBounds(rest.action.box, keyboard.action.box)
	await page.keyboard.press('Enter')
	await expect(card.locator('.pal-computer-status')).toHaveText('Connecting…')
	await expect(action).toHaveCount(0)
	await expect(card.getByRole('button', { name: /^(Start|Stop) computer$/ })).toHaveCount(0)
	await inspect('connecting', card)
	await page.evaluate(() => window.__palComputerStatusProof.state.releaseStart())
	await expect(action).toHaveAttribute('aria-label', 'Stop computer')
	await page.mouse.move(1, 1)
	const ready = await inspect('ready-rest', card, 'Stop computer')
	assert.equal(ready.action.rest, 'Connected')
	assert.equal(ready.action.restOpacity, 1)
	await action.hover()
	const readyHover = await inspect('ready-hover', card, 'Stop computer')
	assert.equal(readyHover.action.hoverOpacity, 1)
	sameBounds(ready.action.box, readyHover.action.box)
	await capture(card, 'connected-hover')
	await action.click()
	await expect(action).toHaveAttribute('aria-label', 'Start computer')
	await expect(page.locator('.pal-computer-view')).toHaveCount(0)
	await card.getByRole('button', { name: 'Pause Sıtkı', exact: true }).click()
	await expect(card.getByRole('button', { name: 'Resume Sıtkı', exact: true })).toBeVisible()
	await expect(action).toHaveCount(0)
	await expect(card.locator('.pal-computer-status')).toHaveText('Offline')
	await inspect('paused-offline', card)
	await card.getByRole('button', { name: 'Resume Sıtkı', exact: true }).click()
	await expect(action).toHaveAttribute('aria-label', 'Start computer')
	await page.evaluate(() => window.__palComputerStatusProof.setComputer({ status: 'ready', generation: 'fixture-generation-2', environmentId: 'memory-fixture' }))
	await expect(action).toHaveAttribute('aria-label', 'Stop computer')
	await page.evaluate(() => {
		const proof = window.__palComputerStatusProof
		proof.emit({ kind: 'permission', request: {
			id: 'fixture-permission', sessionId: proof.state.sessionId, projectId: proof.state.projectId,
			calls: [{ id: 'fixture-call', name: 'fixture-work', input: {}, isDestructive: false }],
		} })
	})
	await expect(action).toBeDisabled()
	await action.hover()
	const busy = await inspect('permission-disabled', card, 'Stop computer')
	assert.equal(busy.action.restOpacity, 1)
	assert.equal(busy.action.hoverOpacity, 0)
	assert.equal(busy.action.pointerEvents, 'auto')
	const stopsBefore = await page.evaluate(() => window.__palComputerStatusProof.state.stops.length)
	await page.mouse.click(busy.action.box.x + busy.action.box.width / 2, busy.action.box.y + busy.action.box.height / 2)
	assert.equal(await page.evaluate(() => window.__palComputerStatusProof.state.stops.length), stopsBefore)
	await expect(page.locator('.pal-computer-view')).toHaveCount(0)
	await page.evaluate(() => {
		const proof = window.__palComputerStatusProof
		proof.emit({ kind: 'permission-cleared', sessionId: proof.state.sessionId, requestId: 'fixture-permission' })
		proof.emit({ kind: 'state', sessionId: proof.state.sessionId, running: true, queued: [] })
	})
	await expect(action).toBeDisabled()
	await inspect('working-disabled', card, 'Stop computer')
	await page.evaluate(() => {
		const proof = window.__palComputerStatusProof
		proof.emit({ kind: 'state', sessionId: proof.state.sessionId, running: false, queued: [] })
		proof.setComputer({ status: 'unavailable', notice: 'Fixture startup could not be confirmed. Retry starting the computer.' })
	})
	await expect(action).toBeEnabled()
	await expect(action).toHaveAttribute('aria-label', 'Start computer')
	await expect(card.getByRole('button', { name: 'Stop computer', exact: true })).toHaveCount(0)
	await action.hover()
	const failed = await inspect('failed-start-retry', card, 'Start computer')
	assert.equal(failed.action.rest, 'Offline')
	assert.equal(failed.action.hoverOpacity, 1)
	await page.evaluate(() => window.__palComputerStatusProof.setComputer({
		status: 'unavailable', requiresStop: true,
		notice: 'Fixture cleanup was not confirmed. Retry stopping the computer.',
	}))
	await expect(action).toHaveAttribute('aria-label', 'Stop computer')
	await expect(card.getByRole('button', { name: 'Start computer', exact: true })).toHaveCount(0)
	await action.hover()
	const cleanup = await inspect('cleanup-retry', card, 'Stop computer')
	assert.equal(cleanup.action.rest, 'Offline')
	assert.equal(cleanup.action.hoverOpacity, 1)
	await capture(card, 'cleanup-hover')
	await action.click()
	await expect(action).toHaveAttribute('aria-label', 'Start computer')
	await page.setViewportSize({ width: 1024, height: 420 })
	await page.mouse.move(1, 1)
	const shortRest = await inspect('short-offline-rest', card, 'Start computer')
	await action.hover()
	const shortHover = await inspect('short-offline-hover', card, 'Start computer')
	sameBounds(shortRest.action.box, shortHover.action.box)
	await capture(card, 'short-hover')
	const state = await page.evaluate(() => {
		const { releaseStart, ...state } = window.__palComputerStatusProof.state
		return state
	})
	assert.equal(state.starts.length, 1)
	assert.equal(state.stops.length, 2)
	assert.ok(state.starts.every((id) => id === state.stops[0]))
	assert.equal(state.startPending, false)
	assert.equal(state.modelRequests, 0)
	assert.deepEqual(faults, [])
	await writeFile(receipt, `${JSON.stringify({
		version: 1, passed: true, verifiedAt: new Date().toISOString(), origin,
		scope: 'Isolated browser design preview; actual PalContextCard with memory-only computer API stubs.',
		modelRequests: 0, providerRequests: 0, guestActions: 0, nativeActions: 0,
		externalRequests: { allowed: 0, blocked: externalRequests },
		checks: ['No separate card lifecycle footer', 'Offline rest reveals Start on hover without target movement', 'Actual keyboard Tab reveals Start and Enter invokes exactly one synthetic startup', 'Connecting hides lifecycle actions', 'Connected rest reveals Stop on hover and click invokes synthetic stop', 'Paused offline has no Start action', 'Permission and working states disable Stop; disabled hover stays Connected and click cannot fall through to Open', 'Startup failure keeps inline Start retry available', 'Failed cleanup prioritizes Stop retry over Start', 'Short viewport preserves stable inline action target'],
		state, measurements, screenshots, faults,
	}, null, 2)}\n`)
	console.log(JSON.stringify({ passed: true, receipt, starts: state.starts.length, stops: state.stops.length, screenshots }))
} catch (error) {
	await writeFile(receipt, `${JSON.stringify({ version: 1, passed: false, verifiedAt: new Date().toISOString(), scope: 'Isolated design preview only', error: error instanceof Error ? error.message : String(error), measurements, screenshots, faults, externalRequests }, null, 2)}\n`)
	throw error
} finally {
	await browser.close()
}
