/** Deferred metadata proof for authoritative Pal history activation.
 * Uses Vite's real sample API for Pal/session creation and injects only the
 * admitted history/metadata responses. No model, provider, guest or computer
 * execution is started.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/preview'
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' })
const page = await context.newPage()
page.setDefaultTimeout(12_000)
const faults = []
page.on('pageerror', (error) => faults.push(error.message))
await context.route('**/*', (route) =>
	new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort(),
)
await mkdir(artifacts, { recursive: true })

await page.addInitScript(() => {
	let api
	const listeners = new Set()
	const workspace = {
		windowId: 'progressive-proof-window',
		sequence: 0,
		homeGroupId: 'progressive-proof-group',
		layout: { version: 1, revision: 0, windows: [{
			id: 'progressive-proof-window', focusedGroupId: 'progressive-proof-group',
			root: { kind: 'group', id: 'progressive-proof-group', tabs: [], activeTabId: '' },
		}] },
	}
	const state = {
		events: [],
		historyCalls: {},
		historyGates: {},
		historyPlans: {},
		providerGates: {},
		providerPlans: {},
		pal: null,
		project: null,
		first: null,
		second: null,
	}
	const record = (method, sessionId, extra = {}) => {
		state.events.push({ index: state.events.length, method, sessionId, ...extra })
	}
	const permissionThread = (sessionId, projectId) => ({
		revision: 1,
		tasks: [],
		messages: [],
		timeline: [],
		turn: 1,
		turns: {},
		running: false,
		queued: [],
		queuedItems: [],
		activeToolIds: [],
		permissions: [{
			id: `approval-${sessionId}`,
			sessionId,
			projectId,
			calls: [{ id: `call-${sessionId}`, name: 'fixture_action', input: { label: 'approval fixture' }, isDestructive: false }],
		}],
		reasoning: {},
		responding: false,
	})
	const setup = async (original) => {
		if (state.first) return
		state.pal = await original.createPal({
			name: 'Sıtkı', purpose: 'Progressive history fixture',
			model: { provider: 'anthropic', model: 'sample-balanced' },
		})
		const opened = await original.openPal(state.pal.id)
		state.project = opened.project
		state.first = await original.newConversation(opened.project.id)
	}
	Object.defineProperty(window, 'namzu', {
		configurable: true,
		get: () => api,
		set: (value) => {
			api = value
			const original = {
				pals: api.pals.bind(api),
				projects: api.projects.bind(api),
				conversations: api.conversations.bind(api),
				createPal: api.createPal.bind(api),
				openPal: api.openPal.bind(api),
				newConversation: api.newConversation.bind(api),
				openConversation: api.openConversation.bind(api),
				providers: api.providers.bind(api),
				draft: api.draft.bind(api),
				draftSettings: api.draftSettings.bind(api),
				attachments: api.attachments.bind(api),
				modelSettings: api.modelSettings.bind(api),
				plugins: api.plugins.bind(api),
				selectProvider: api.selectProvider.bind(api),
				approve: api.approve.bind(api),
				send: api.send.bind(api),
				onEvent: api.onEvent.bind(api),
			}
			window.__progressiveProof = {
				events: state.events,
				ready: setup(original),
				get firstSession() { return state.first?.id },
				get secondSession() { return state.second?.id },
				get projectId() { return state.project?.id },
				armProvider(sessionId, outcome) {
					state.providerPlans[sessionId] ??= []
					state.providerPlans[sessionId].push(outcome)
				},
				armHistory(sessionId, outcome = 'resolve') {
					state.historyPlans[sessionId] ??= []
					state.historyPlans[sessionId].push(outcome)
				},
				releaseHistory(sessionId, outcome = 'resolve') {
					const gates = state.historyGates[sessionId] ?? []
					const gate = gates.find((candidate) => !candidate.settled)
					if (!gate) throw new Error(`No deferred history read is pending for ${sessionId}.`)
					gate.settled = true
					if (outcome === 'reject') gate.reject(new Error(`Deferred history read failed for ${sessionId}.`))
					else gate.resolve()
				},
				releaseProvider(sessionId, outcome = 'resolve') {
					const gates = state.providerGates[sessionId] ?? []
					const gate = gates.find((candidate) => !candidate.settled)
					if (!gate) throw new Error(`No deferred provider read is pending for ${sessionId}.`)
					gate.settled = true
					if (outcome === 'reject') gate.reject(new Error(`Deferred provider metadata failed for ${sessionId}.`))
					else gate.resolve()
				},
				async createSecondConversation() {
					state.second = await original.newConversation(state.project.id)
					return state.second.id
				},
			}
			api.workspace = async () => structuredClone(workspace)
			api.workspaceAction = async (action) => {
				const group = workspace.layout.windows[0].root
				if (action.kind === 'open' || action.kind === 'activate') {
					if (!group.tabs.includes(action.tabId)) group.tabs.push(action.tabId)
					group.activeTabId = action.tabId
				} else if (action.kind === 'close') {
					group.tabs = group.tabs.filter((tabId) => tabId !== action.tabId)
					if (group.activeTabId === action.tabId) group.activeTabId = group.tabs.at(-1) ?? ''
				}
				workspace.layout.revision++
				workspace.sequence++
				return structuredClone(workspace)
			}
			api.openPal = async (id) => {
				record('openPal:start', id)
				const result = await original.openPal(id)
				record('openPal:resolved', id)
				return result
			}
			api.onEvent = (listener) => {
				listeners.add(listener)
				const unsubscribe = original.onEvent(listener)
				return () => { listeners.delete(listener); unsubscribe() }
			}
			api.pals = async () => { await setup(original); return original.pals() }
			api.projects = async () => { await setup(original); return original.projects() }
			api.conversations = async (projectId) => {
				await setup(original)
				const rows = await original.conversations(projectId)
				return rows.map((view) => view.id === state.first?.id
					? { ...view, title: 'Sıtkı history fixture' }
					: view.id === state.second?.id
						? { ...view, title: 'Sıtkı error fixture' }
						: view)
			}
			api.newConversation = async (projectId) => {
				await setup(original)
				const view = await original.newConversation(projectId)
				if (projectId === state.project.id && !state.second) state.second = view
				return view
			}
			api.openConversation = async (projectId, sessionId) => {
				await setup(original)
				if (sessionId !== state.first?.id && sessionId !== state.second?.id) return original.openConversation(projectId, sessionId)
				const ordinal = (state.historyCalls[sessionId] ?? 0) + 1
				state.historyCalls[sessionId] = ordinal
				record('openConversation:start', sessionId, { ordinal })
				const historyOutcome = state.historyPlans[sessionId]?.shift()
				if (historyOutcome) {
					try {
						await new Promise((resolve, reject) => {
							state.historyGates[sessionId] ??= []
							state.historyGates[sessionId].push({ resolve, reject, settled: false, outcome: historyOutcome })
							record('openConversation:held', sessionId, { ordinal, outcome: historyOutcome })
						})
					} catch (failure) {
						record('openConversation:rejected', sessionId, { ordinal })
						throw failure
					}
				}
				const messages = [
					{ role: 'user', text: `AUTHORITATIVE_HISTORY_${sessionId}_${ordinal}`, messageId: `request-${sessionId}-${ordinal}` },
					{ role: 'assistant', text: `Saved answer ${ordinal}`, messageId: `answer-${sessionId}-${ordinal}`, status: 'completed', phase: 'final_answer' },
				]
				const thread = permissionThread(sessionId, projectId)
				thread.queued = ['Queued action must wait for refreshed history']
				thread.queuedItems = [{ id: `queued-${sessionId}`, prompt: 'Queued action must wait for refreshed history' }]
				thread.timeline = messages.map((_, index) => ({ kind: 'message', index, turn: 1 }))
				record('openConversation:resolved', sessionId, { ordinal })
				return { messages, partial: false, thread }
			}
			api.providers = async (projectId, sessionId) => {
				await setup(original)
				if (sessionId !== state.first?.id && sessionId !== state.second?.id) return original.providers(projectId, sessionId)
				record('providers:start', sessionId)
				const outcome = state.providerPlans[sessionId]?.shift()
				const result = await original.providers(projectId, sessionId)
				if (!outcome) {
					record('providers:resolved', sessionId)
					return result
				}
				await new Promise((resolve, reject) => {
					state.providerGates[sessionId] ??= []
					state.providerGates[sessionId].push({ resolve, reject, settled: false, outcome })
					record('providers:held', sessionId, { outcome })
				})
				if (outcome === 'hold-error') throw new Error(`Deferred provider metadata failed for ${sessionId}.`)
				record('providers:resolved', sessionId)
				return result
			}
			for (const [method, base] of Object.entries({
				draft: original.draft,
				draftSettings: original.draftSettings,
				attachments: original.attachments,
				modelSettings: original.modelSettings,
				plugins: original.plugins,
			})) {
				if (typeof base !== 'function') continue
				api[method] = async (...args) => {
					const sessionId = method === 'modelSettings' ? args[3]
						: method === 'plugins' ? args[1]
							: args[0]
					if (sessionId === state.first?.id || sessionId === state.second?.id)
						record(`${method}:start`, sessionId)
					// Startup can request workspace-scoped metadata before a conversation
					// is selected. The preview's owner() parser predates scoped IDs, so
					// serve those empty fixture values locally instead of hitting it.
					if (typeof args[0] === 'string' && args[0].startsWith('project:'))
						return method === 'attachments' ? [] : method === 'draft' ? '' : {}
					const result = await base(...args)
					if (sessionId === state.first?.id || sessionId === state.second?.id)
						record(`${method}:resolved`, sessionId)
					return result
				}
			}
			for (const [method, base] of Object.entries({ selectProvider: original.selectProvider, approve: original.approve, send: original.send })) {
				api[method] = async (...args) => {
					const sessionId = method === 'selectProvider' ? args[0] : args[0]
					record(`${method}:called`, sessionId)
					return base(...args)
				}
			}
		},
	})
})

const marker = (sessionId, ordinal) => `AUTHORITATIVE_HISTORY_${sessionId}_${ordinal}`
const flushFrames = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
const eventSnapshot = () => page.evaluate(() => structuredClone(window.__progressiveProof.events))
const proofState = () => page.evaluate(() => ({
	first: window.__progressiveProof.firstSession,
	second: window.__progressiveProof.secondSession,
	projectId: window.__progressiveProof.projectId,
}))
const expectModelActionUnavailable = async () => {
	const controls = page.getByRole('button', { name: /model/i })
	const count = await controls.count()
	for (let index = 0; index < count; index++) await expect(controls.nth(index)).toBeDisabled()
}

try {
	await page.goto(origin)
	await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
	await page.waitForFunction(() => window.__progressiveProof?.firstSession)
	const { first, projectId } = await proofState()
	assert.ok(first && projectId)
	await page.evaluate((id) => window.__progressiveProof.armProvider(id, 'hold-success'), first)
	await page.locator('.sidebar-pal-row').filter({ hasText: 'Sıtkı' }).click()
	const firstMarker = marker(first, 1)
	await expect(page.locator('.pal-chat-transcript')).toContainText(firstMarker)
	await page.waitForFunction((id) => window.__progressiveProof.events.some((event) => event.method === 'providers:held' && event.sessionId === id), first)
	const input = page.getByRole('textbox', { name: 'Message Namzu', exact: true })
	await expect(input).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await expectModelActionUnavailable()
	await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toBeVisible()
	await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled()
	const metadataMethods = ['providers', 'draft', 'draftSettings', 'attachments']
	await page.waitForFunction(({ id, methods }) => {
		const started = new Set(window.__progressiveProof.events.filter((event) => event.sessionId === id && event.method.endsWith(':start')).map((event) => event.method.slice(0, -6)))
		return methods.every((method) => started.has(method))
	}, { id: first, methods: metadataMethods })
	const pendingEvents = await eventSnapshot()
	const pendingCalls = pendingEvents.filter((event) => event.sessionId === first)
	const methodStartIndexes = metadataMethods.map((method) => pendingCalls.find((event) => event.method === `${method}:start`)?.index)
	assert.ok(methodStartIndexes.every(Number.isInteger), `all four metadata reads should start while provider is held: ${JSON.stringify(pendingCalls)}`)
	assert.ok(pendingCalls.some((event) => event.method === 'providers:held'))
	assert.equal(pendingCalls.some((event) => event.method === 'providers:resolved'), false)
	assert.deepEqual(pendingCalls.filter((event) => metadataMethods.includes(event.method.replace(/:start$/, ''))).map((event) => event.method.replace(/:start$/, '')).sort(), [...metadataMethods].sort())
	await page.screenshot({ path: join(artifacts, 'pal-reopen-progressive-pending-20261006.png') })

	// Leave the cold Pal tab selected state while its provider response is pending.
	await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
	const normalTab = page.getByRole('tab', { name: 'Namzu: Refine navigation', exact: true })
	await expect(normalTab).toHaveAttribute('aria-selected', 'true')
	await page.evaluate((id) => window.__progressiveProof.releaseProvider(id, 'resolve'), first)
	await page.waitForFunction((id) => window.__progressiveProof.events.some((event) => event.method === 'providers:resolved' && event.sessionId === id), first)
	await flushFrames()
	await expect(normalTab).toHaveAttribute('aria-selected', 'true')
	await page.screenshot({ path: join(artifacts, 'pal-reopen-progressive-after-navigation-20261006.png') })

	// Close and reopen the same cold conversation; this metadata flight settles fully.
	await page.getByRole('button', { name: 'Close tab Sıtkı', exact: true }).click()
	await expect(page.getByRole('tab', { name: 'Sıtkı', exact: true })).toHaveCount(0)
	await page.locator('.sidebar-pal-row').filter({ hasText: 'Sıtkı' }).click()
	const secondMarker = marker(first, 2)
	await expect(page.locator('.pal-chat-transcript')).toContainText(secondMarker)
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEnabled()
	await page.waitForFunction((id) => window.__progressiveProof.events.some((event) => event.method === 'providers:resolved' && event.sessionId === id), first)
	// Move to the ordinary conversation before measuring a warm Pal-tab activation.
	await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
	const warmBefore = (await eventSnapshot()).filter((event) => event.sessionId === first).length
	const palTab = page.getByRole('tab', { name: 'Sıtkı', exact: true })
	await palTab.click()
	await expect(palTab).toHaveAttribute('aria-selected', 'true')
	await expect(page.locator('.pal-chat-transcript')).toContainText(secondMarker)
	await flushFrames()
	const warmAfter = (await eventSnapshot()).filter((event) => event.sessionId === first).length
	assert.equal(warmAfter, warmBefore, 'selecting a warmed Pal tab should not call history or metadata APIs')
	const firstSessionEvents = (await eventSnapshot()).filter((event) => event.sessionId === first)

	// A confirmed closed Pal can reopen from the catalog without another
	// openPal read. Keep main history pending to inspect the saved transcript.
	await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
	await page.getByRole('button', { name: 'Close tab Sıtkı', exact: true }).click()
	const openPalBefore = (await eventSnapshot()).filter((event) => event.method === 'openPal:start').length
	await page.evaluate((id) => window.__progressiveProof.armHistory(id), first)
	await page.locator('.sidebar-pal-row').filter({ hasText: 'Sıtkı' }).click()
	await page.waitForFunction((id) => window.__progressiveProof.events.some(
		(event) => event.method === 'openConversation:held' && event.sessionId === id && event.ordinal === 3,
	), first)
	const refreshingStatus = page.locator('.conversation-refresh')
	await expect(refreshingStatus).toHaveText('Updating conversation…')
	await expect(page.locator('.transcript')).toHaveAttribute('data-history-state', 'saved')
	await expect(page.locator('.pal-chat-transcript')).toContainText(secondMarker)
	const heldOpenPalCount = (await eventSnapshot()).filter((event) => event.method === 'openPal:start').length
	assert.equal(heldOpenPalCount, openPalBefore, 'confirmed catalogue reopen should not call openPal')
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled()
	await page.getByRole('button', { name: 'Show queued messages', exact: true }).click()
	await expect(page.getByRole('button', { name: 'Edit queued message 1', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Remove queued message 1', exact: true })).toBeDisabled()
	await page.screenshot({ path: join(artifacts, 'pal-reopen-progressive-saved-refresh-20261006.png') })

	await page.evaluate((id) => window.__progressiveProof.releaseHistory(id), first)
	const refreshedMarker = marker(first, 3)
	await expect(page.locator('.pal-chat-transcript')).toContainText(refreshedMarker)
	await expect(page.locator('.transcript')).toHaveAttribute('data-history-state', 'authoritative')
	await expect(page.locator('.pal-chat-transcript')).not.toContainText(secondMarker)
	await expect(refreshingStatus).toHaveCount(0)
	await page.waitForFunction(({ id, methods }) => {
		const started = new Set(window.__progressiveProof.events.filter((event) => event.sessionId === id && event.method.endsWith(':start')).map((event) => event.method.slice(0, -6)))
		return methods.every((method) => started.has(method))
	}, { id: first, methods: metadataMethods })
	const refreshedEvents = (await eventSnapshot()).filter((event) => event.sessionId === first)
	const refreshReadIndex = refreshedEvents.find((event) => event.method === 'openConversation:resolved' && event.ordinal === 3)?.index
	assert.ok(Number.isInteger(refreshReadIndex), 'deferred refreshed history should resolve before metadata admission')
	assert.ok(metadataMethods.every((method) => refreshedEvents.some(
		(event) => event.method === `${method}:start` && event.index > refreshReadIndex,
	)), 'all four metadata reads should start after refreshed history resolves')
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEnabled()

	// A later closed-history refresh can fail without dropping the last saved
	// transcript. Retry setup must fetch history and all metadata before admission.
	await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
	await page.getByRole('button', { name: 'Close tab Sıtkı', exact: true }).click()
	const failedRefreshOpenPalCount = (await eventSnapshot()).filter((event) => event.method === 'openPal:start').length
	await page.evaluate((id) => window.__progressiveProof.armHistory(id, 'reject'), first)
	await page.locator('.sidebar-pal-row').filter({ hasText: 'Sıtkı' }).click()
	await page.waitForFunction((id) => window.__progressiveProof.events.some(
		(event) => event.method === 'openConversation:held' && event.sessionId === id && event.ordinal === 4,
	), first)
	await expect(page.locator('.pal-chat-transcript')).toContainText(refreshedMarker)
	await expect(page.locator('.conversation-refresh')).toHaveText('Updating conversation…')
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeDisabled()
	await page.evaluate((id) => window.__progressiveProof.releaseHistory(id, 'reject'), first)
	await page.getByRole('alert').filter({ hasText: `Deferred history read failed for ${first}` }).waitFor()
	await expect(page.locator('.conversation-refresh')).toHaveText('Saved messages')
	await expect(page.locator('.transcript')).toHaveAttribute('data-history-state', 'saved')
	await expect(page.locator('.pal-chat-transcript')).toContainText(refreshedMarker)
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
	const retrySavedReadBefore = (await eventSnapshot()).filter((event) => event.method === 'openConversation:start' && event.sessionId === first).length
	await page.screenshot({ path: join(artifacts, 'pal-reopen-progressive-saved-history-error-20261006.png') })
	await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
	await page.waitForFunction((id) => window.__progressiveProof.events.some(
		(event) => event.method === 'openConversation:resolved' && event.sessionId === id && event.ordinal === 5,
	), first)
	const retrySavedMarker = marker(first, 5)
	await expect(page.locator('.pal-chat-transcript')).toContainText(retrySavedMarker)
	await expect(page.locator('.pal-chat-transcript')).not.toContainText(refreshedMarker)
	await expect(page.locator('.transcript')).toHaveAttribute('data-history-state', 'authoritative')
	await expect(page.locator('.conversation-refresh')).toHaveCount(0)
	await page.waitForFunction(({ id, methods }) => {
		const events = window.__progressiveProof.events.filter((event) => event.sessionId === id)
		const start = events.find((event) => event.method === 'openConversation:resolved' && event.ordinal === 5)?.index
		const completed = new Set(events.filter((event) => event.index > start && event.method.endsWith(':resolved')).map((event) => event.method.slice(0, -9)))
		return Number.isInteger(start) && methods.every((method) => completed.has(method))
	}, { id: first, methods: metadataMethods })
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEnabled()
	const retrySavedEvents = (await eventSnapshot()).filter((event) => event.sessionId === first)
	assert.equal(retrySavedEvents.filter((event) => event.method === 'openConversation:start').length, retrySavedReadBefore + 1)
	assert.equal(retrySavedEvents.filter((event) => event.method === 'openPal:start').length, failedRefreshOpenPalCount)

	// Reload the isolated preview fixture so the error path starts from a fresh
	// cold session with no retained Pal tab or warm history cache.
	await page.reload()
	await page.getByRole('status', { name: 'Design preview', exact: true }).waitFor()
	await page.waitForFunction(() => window.__progressiveProof?.firstSession)
	const second = await page.evaluate(() => window.__progressiveProof.firstSession)
	await page.evaluate((id) => window.__progressiveProof.armProvider(id, 'hold-error'), second)
	await page.locator('.sidebar-pal-row').filter({ hasText: 'Sıtkı' }).click()
	const errorMarker = marker(second, 1)
	await expect(page.locator('.pal-chat-transcript')).toContainText(errorMarker)
	await page.waitForFunction((id) => window.__progressiveProof.events.some((event) => event.method === 'providers:held' && event.sessionId === id), second)
	await page.waitForFunction(({ id, methods }) => {
		const started = new Set(window.__progressiveProof.events.filter((event) => event.sessionId === id && event.method.endsWith(':start')).map((event) => event.method.slice(0, -6)))
		return methods.every((method) => started.has(method))
	}, { id: second, methods: metadataMethods })
	await page.evaluate((id) => window.__progressiveProof.releaseProvider(id, 'reject'), second)
	await expect(page.getByRole('alert')).toContainText(`Deferred provider metadata failed for ${second}`)
	await expect(page.locator('.pal-chat-transcript')).toContainText(errorMarker)
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	await expectModelActionUnavailable()
	await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
	await page.screenshot({ path: join(artifacts, 'pal-reopen-progressive-error-20261006.png') })

	// Retry setup runs the normal cold restore again. The unheld provider read
	// now resolves, but the fixture must retain the same route and approval data.
	await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
	await page.waitForFunction((id) => window.__progressiveProof.events.some(
		(event) => event.method === 'openConversation:resolved' && event.sessionId === id && event.ordinal === 2,
	), second)
	const recoveredMarker = marker(second, 2)
	const retryPalTab = page.getByRole('tab', { name: 'Sıtkı', exact: true })
	await expect(retryPalTab).toHaveAttribute('aria-selected', 'true')
	await expect(page.locator('.pal-chat-transcript')).toContainText(recoveredMarker)
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEnabled()
	await expect(page.getByRole('region', { name: 'Tool approval', exact: true })).toContainText('fixture_action')
	await expect(page.getByRole('alert')).toHaveCount(0)

	const events = await eventSnapshot()
	assert.deepEqual(events.filter((event) => ['selectProvider:called', 'approve:called', 'send:called'].includes(event.method)), [])
	assert.deepEqual(faults, [])
	const receipt = {
		passed: true,
		browserPreview: true,
		fixture: 'Pal and conversation IDs were created through Vite preview API; history and metadata responses were intercepted in-page.',
		modelRequests: 0,
		providerRequests: 0,
		computerCalls: 0,
		externalRequests: 'aborted',
		checks: [
			'cold open renders fresh authoritative Pal history while the provider read is explicitly deferred',
			'provider, draft, draftSettings, and attachments reads all start before provider resolution',
			'composer, send, model selection, and pending approval actions remain unavailable while metadata is held',
			'navigating to a normal conversation before provider release does not overwrite the selected route',
			'closing and reopening after success hydrates; switching to a warm Pal tab makes no history or metadata calls',
			'after a confirmed closed-Pal reopen, openPal is skipped and saved transcript remains visible with Updating conversation while deferred authoritative history, queue, composer, and approval gates are pending',
			'new authoritative history replaces the saved transcript and enters metadata admission after release',
			'a deferred closed-history failure keeps the prior saved transcript in Saved messages state and blocks the composer; Retry setup fetches newer history plus all four metadata reads before admission',
			'after a fresh preview reload, provider metadata rejection keeps authoritative history visible and leaves composer/model/approval actions blocked',
			'Retry setup performs a fresh authoritative history read for the same selected Pal, restores the composer, and retains approval fixture data without invoking provider selection, approval, or send',
		],
		firstSession: first,
		secondSession: second,
		metadataMethods,
		firstSessionEvents,
		refreshedEvents,
		closedPalRefresh: {
			sessionId: first,
			openPalCallsBefore: openPalBefore,
			openPalCallsWhileHeld: heldOpenPalCount,
			savedMarker: secondMarker,
			refreshedMarker,
			queueActionsBlocked: true,
			composerBlockedWhileRefreshing: true,
			approvalBlockedWhileRefreshing: true,
		},
		savedHistoryRetry: {
			sessionId: first,
			failedHistoryOrdinal: 4,
			retryHistoryOrdinal: 5,
			retainedMarkerAfterFailure: refreshedMarker,
			recoveredMarker: retrySavedMarker,
			metadataCompletedBeforeAdmission: true,
			openPalCallsUnchanged: true,
		},
		secondSessionEvents: events.filter((event) => event.sessionId === second),
		retryRecovery: {
			sessionId: second,
			historyOrdinal: 2,
			transcriptMarker: recoveredMarker,
			composerEnabled: true,
			approvalFixtureRetained: true,
			actionCalls: events.filter((event) => ['selectProvider:called', 'approve:called', 'send:called'].includes(event.method)),
		},
		warmTabCallCounts: { before: warmBefore, after: warmAfter },
		fixtureLimits: 'Sample Vite API only; no model or provider execution. The error case reloads the preview, whose in-memory fixture resets and reuses sample-thread-7; it does not model durable Pal persistence. The provider response is a deferred synthetic API value, not a live connection.',
		faults,
	}
	await writeFile(join(artifacts, 'pal-reopen-progressive-browser-proof-20261006.json'), `${JSON.stringify(receipt, null, 2)}\n`)
	console.log(JSON.stringify({ passed: true, firstSession: first, secondSession: second, calls: events.length }))
} catch (error) {
	if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'pal-reopen-progressive-browser-failure-20261006.png') }).catch(() => {})
	console.error(JSON.stringify({ failed: true, message: error instanceof Error ? error.message : String(error), events: await eventSnapshot().catch(() => []) }))
	throw error
} finally {
	await browser.close()
}
