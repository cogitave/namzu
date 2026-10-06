/**
 * Deferred Recents navigation proof against the real Vite renderer.
 * Only sample conversations and synthetic main-process responses are used.
 * Gates release on explicit events; elapsed time never decides an assertion.
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
// Browser and filesystem I/O use Playwright's own assertion timeout; no timing
// race or latency threshold is part of the proof.
page.setDefaultTimeout(12_000)
const faults = []
page.on('pageerror', (error) => faults.push(error.message))
await context.route('**/*', (route) =>
	new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort(),
)
await mkdir(artifacts, { recursive: true })

await page.addInitScript(() => {
	let api
	const definitions = {
		'sample-thread-1': { projectId: 'sample-app', title: 'Refine navigation', draft: 'DRAFT_A_MAIN', provider: 'anthropic', model: 'sample-balanced' },
		'sample-thread-4': { projectId: 'sample-docs', title: 'Improve the quick start', draft: 'DRAFT_B_MAIN', provider: 'sample-local', model: 'sample-focused' },
		'sample-thread-2': { projectId: 'sample-app', title: 'Polish empty states', draft: 'DRAFT_C_MAIN', provider: 'anthropic', model: 'sample-balanced' },
	}
	const state = {
		events: [],
		violations: [],
		actions: [],
		registered: new Set(),
		counts: {},
		plans: {},
		gates: {},
	}
	const workspace = {
		windowId: 'recents-proof-window',
		sequence: 0,
		homeGroupId: 'recents-proof-group',
		layout: {
			version: 1,
			revision: 0,
			windows: [{
				id: 'recents-proof-window',
				focusedGroupId: 'recents-proof-group',
				root: { kind: 'group', id: 'recents-proof-group', tabs: [], activeTabId: '' },
			}],
		},
	}
	const record = (method, sessionId, extra = {}) => {
		state.events.push({ index: state.events.length, method, sessionId, ...extra })
	}
	const keyFor = (method, sessionId) => `${method}:${sessionId}`
	const admission = (method, sessionId, projectId) => {
		if (!definitions[sessionId]) return
		if (!state.registered.has(sessionId) ||
			(projectId !== undefined && definitions[sessionId].projectId !== projectId)) {
			const violation = { method, sessionId, projectId, registered: state.registered.has(sessionId) }
			state.violations.push(violation)
			throw new Error(`Metadata read before main registration or for a foreign project: ${method}/${sessionId}`)
		}
	}
	const gate = async (method, sessionId, ordinal) => {
		const key = keyFor(method, sessionId)
		const planned = state.plans[key]?.shift()
		if (!planned) return
		try {
			await new Promise((resolve, reject) => {
				state.gates[key] ??= []
				state.gates[key].push({ resolve, reject, settled: false, planned })
				record(`${method}:held`, sessionId, { ordinal })
			})
		} catch (error) {
			record(`${method}:rejected`, sessionId, { ordinal })
			throw error
		}
	}
	const start = (method, sessionId) => {
		const key = keyFor(method, sessionId)
		const ordinal = (state.counts[key] ?? 0) + 1
		state.counts[key] = ordinal
		record(`${method}:start`, sessionId, { ordinal })
		return ordinal
	}
	Object.defineProperty(window, 'namzu', {
		configurable: true,
		get: () => api,
		set: (value) => {
			api = value
			const base = { ...value }
			// The design preview omits optional engine discovery; supply its native
			// read shape so admission ordering exercises that effect as well.
			base.harnesses ??= async () => ({ selected: 'namzu', locked: false, engines: [] })
			window.__recentsProof = {
				events: state.events,
				violations: state.violations,
				actions: state.actions,
				arm(method, sessionId, outcome = 'resolve') {
					const key = keyFor(method, sessionId)
					state.plans[key] ??= []
					state.plans[key].push(outcome)
				},
				release(method, sessionId, outcome) {
					const pending = state.gates[keyFor(method, sessionId)]?.find((candidate) => !candidate.settled)
					if (!pending) throw new Error(`No ${method} gate is pending for ${sessionId}.`)
					pending.settled = true
					if ((outcome ?? pending.planned) === 'reject')
						pending.reject(new Error(`Deferred ${method} failed for ${sessionId}.`))
					else pending.resolve()
				},
			}
			api.workspace = async () => structuredClone(workspace)
			api.conversations = async (projectId) => {
				record('catalogue:start', undefined, { projectId })
				const rows = await base.conversations(projectId)
				record('catalogue:resolved', undefined, { projectId })
				return rows
			}
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
				record(`workspace:${action.kind}`, action.tabId)
				return structuredClone(workspace)
			}
			api.openConversation = async (projectId, sessionId) => {
				const definition = definitions[sessionId]
				if (!definition) return base.openConversation(projectId, sessionId)
				if (definition.projectId !== projectId) throw new Error('Foreign fixture project.')
				const ordinal = start('history', sessionId)
				await gate('history', sessionId, ordinal)
				state.registered.add(sessionId)
				const messages = [
					{ role: 'user', text: `RECENTS_HISTORY_${sessionId}_${ordinal}`, messageId: `request-${sessionId}-${ordinal}` },
					{ role: 'assistant', text: `Confirmed answer ${ordinal}`, messageId: `answer-${sessionId}-${ordinal}`, status: 'completed', phase: 'final_answer' },
				]
				const thread = {
					revision: ordinal,
					tasks: [],
					messages,
					timeline: messages.map((_, index) => ({ kind: 'message', index, turn: 1 })),
					turn: 1,
					turns: {},
					running: false,
					queued: ['Queued fixture must wait for readiness'],
					queuedItems: [{ id: `queued-${sessionId}`, prompt: 'Queued fixture must wait for readiness' }],
					tools: {},
					activeToolIds: [],
					permissions: [{
						id: `approval-${sessionId}`, sessionId, projectId,
						calls: [{ id: `call-${sessionId}`, name: 'fixture_action', input: { label: 'approval fixture' }, isDestructive: false }],
					}],
					reasoning: {},
					responding: false,
				}
				record('history:resolved', sessionId, { ordinal })
				return { messages, partial: false, thread }
			}
			api.readyConversation = async (projectId, sessionId) => {
				admission('readyConversation', sessionId, projectId)
				const ordinal = start('ready', sessionId)
				await gate('ready', sessionId, ordinal)
				record('ready:resolved', sessionId, { ordinal })
			}
			api.providers = async (projectId, sessionId) => {
				const definition = definitions[sessionId]
				if (!definition) return base.providers(projectId, sessionId)
				admission('providers', sessionId, projectId)
				const ordinal = start('providers', sessionId)
				await gate('providers', sessionId, ordinal)
				record('providers:resolved', sessionId, { ordinal })
				return {
					available: [
						{ id: 'anthropic', label: 'Sample provider', defaultModel: 'sample-balanced' },
						{ id: 'sample-local', label: 'Sample local models', defaultModel: 'sample-focused' },
					],
					selected: { id: definition.provider, model: definition.model },
				}
			}
			for (const method of ['draft', 'draftSettings', 'attachments', 'modelSettings', 'models', 'plugins', 'harnesses', 'jobs', 'refreshTasks']) {
				if (!base[method]) continue
				api[method] = async (...args) => {
					const sessionId = method === 'modelSettings' ? args[3]
						: method === 'models' ? args[2]
							: ['plugins', 'harnesses'].includes(method) ? args[1] : args[0]
					const definition = definitions[sessionId]
					if (typeof args[0] === 'string' && args[0].startsWith('project:'))
						return method === 'attachments' ? [] : method === 'draft' ? '' : {}
					if (!definition) return base[method](...args)
					admission(method, sessionId, ['modelSettings', 'models', 'plugins', 'harnesses'].includes(method) ? args[0] : undefined)
					const ordinal = start(method, sessionId)
					let result
					if (method === 'draft') result = definition.draft
					else if (method === 'draftSettings') result = {
						choice: { provider: definition.provider, model: definition.model },
						options: { permissionMode: 'prompt', effort: 'low' },
					}
					else if (method === 'harnesses') result = { selected: 'namzu', locked: false, engines: [] }
					else if (['attachments', 'jobs'].includes(method)) result = []
					else if (method === 'refreshTasks') result = undefined
					else result = await base[method](...args)
					record(`${method}:resolved`, sessionId, { ordinal })
					return result
				}
			}
			for (const method of ['send', 'selectProvider', 'selectHarness', 'approve', 'cancel', 'retryTurn', 'takeQueued', 'removeQueued', 'startPalComputer', 'stopPalComputer', 'rebootPalComputer', 'takeOverPalComputer', 'returnPalComputerControl', 'palComputerInput']) {
				if (!base[method]) continue
				api[method] = async (...args) => {
					state.actions.push({ method, sessionId: args[0] })
					throw new Error(`Forbidden execution in the Recents browser proof: ${method}`)
				}
			}
		},
	})
})

const first = 'sample-thread-1'
const second = 'sample-thread-4'
const third = 'sample-thread-2'
const marker = (id, ordinal) => `RECENTS_HISTORY_${id}_${ordinal}`
const events = () => page.evaluate(() => structuredClone(window.__recentsProof.events))
const arm = (method, id, outcome = 'resolve') => page.evaluate(
	({ method, id, outcome }) => window.__recentsProof.arm(method, id, outcome),
	{ method, id, outcome },
)
const release = (method, id, outcome) => page.evaluate(
	({ method, id, outcome }) => window.__recentsProof.release(method, id, outcome),
	{ method, id, outcome },
)
const waitEvent = (method, id, ordinal) => page.waitForFunction(
	({ method, id, ordinal }) => window.__recentsProof.events.some((event) =>
		event.method === method && event.sessionId === id && (ordinal === undefined || event.ordinal === ordinal)),
	{ method, id, ordinal },
)
const frames = () => page.evaluate(() => new Promise((resolve) =>
	requestAnimationFrame(() => requestAnimationFrame(resolve)),
))
const recent = (title) => page.locator('.sidebar-recent-list').getByRole('button', { name: title, exact: true })
const selectedTab = (title) => page.getByRole('tab', { name: `Namzu: ${title}`, exact: true })
const input = page.getByRole('textbox', { name: 'Message Namzu', exact: true })
const transcript = page.locator('.transcript')
const metadata = ['providers', 'draft', 'draftSettings', 'attachments']
const blocked = async ({ approval = false } = {}) => {
	await expect(input).toBeDisabled()
	await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled()
	const modelControls = page.getByRole('button', { name: /model/i })
	for (let index = 0; index < await modelControls.count(); index++)
		await expect(modelControls.nth(index)).toBeDisabled()
	for (const label of ['Tool permissions', 'Execution engine']) {
		const controls = page.locator(`.composer-wrap button[aria-label="${label}"]`)
		for (let index = 0; index < await controls.count(); index++)
			await expect(controls.nth(index)).toBeDisabled()
	}
	await page.getByRole('button', { name: 'Attachments and message settings', exact: true }).click()
	const messageSettings = page.locator('[data-slot="popover-popup"][aria-label="Attachments and message settings"]')
	await expect(messageSettings.getByRole('button', { name: 'Attach files', exact: true })).toBeDisabled()
	await expect(messageSettings.getByRole('button', { name: 'Plugins', exact: true })).toBeDisabled()
	await page.keyboard.press('Escape')
	if (approval) {
		await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeDisabled()
		await expect(page.getByRole('button', { name: 'Decline', exact: true })).toBeDisabled()
		const showQueue = page.getByRole('button', { name: 'Show queued messages', exact: true })
		if (await showQueue.count()) await showQueue.click()
		await expect(page.getByRole('button', { name: 'Edit queued message 1', exact: true })).toBeDisabled()
		await expect(page.getByRole('button', { name: 'Remove queued message 1', exact: true })).toBeDisabled()
	}
}

try {
	await page.goto(origin)
	await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
	await recent('Refine navigation').waitFor()
	await recent('Improve the quick start').waitFor()
	const catalogueBefore = (await events()).filter((event) => event.method === 'catalogue:start').length
	await arm('history', first)
	await arm('ready', first)
	await recent('Refine navigation').click()
	await waitEvent('history:held', first, 1)
	await expect(selectedTab('Refine navigation')).toHaveAttribute('aria-selected', 'true')
	await expect(transcript).toHaveAttribute('data-history-state', 'loading')
	await expect(page.locator('.conversation-refresh')).toHaveText('Opening conversation…')
	await expect(transcript).not.toContainText(marker(first, 1))
	await blocked()
	assert.equal((await events()).filter((event) => event.method === 'catalogue:start').length, catalogueBefore,
		'opening a known Recents row must not rescan every project catalogue')
	assert.deepEqual((await events()).filter((event) => event.sessionId === first &&
		(metadata.some((method) => event.method === `${method}:start`) || event.method === 'ready:start')), [])
	await page.screenshot({ path: join(artifacts, 'recents-progressive-cold-pending-20261006.png') })

	// A second click on the same Recents row shares the still-held flight.
	await recent('Refine navigation').click()
	await frames()
	assert.equal((await events()).filter((event) => event.method === 'history:start' && event.sessionId === first).length, 1)
	await release('history', first)
	await expect(transcript).toContainText(marker(first, 1))
	await expect(transcript).toHaveAttribute('data-history-state', 'authoritative')
	await waitEvent('ready:held', first, 1)
	await blocked({ approval: true })
	await page.waitForFunction(({ id, methods }) => methods.every((method) =>
		window.__recentsProof.events.some((event) => event.sessionId === id && event.method === `${method}:resolved`)),
	{ id: first, methods: metadata })
	const firstPending = (await events()).filter((event) => event.sessionId === first)
	const firstHistoryIndex = firstPending.find((event) => event.method === 'history:resolved').index
	assert.ok(metadata.every((method) => firstPending.find((event) => event.method === `${method}:start`).index > firstHistoryIndex))
	assert.equal(firstPending.filter((event) => event.method === 'ready:start').length, 1)
	assert.deepEqual(firstPending.filter((event) => ['jobs:start', 'harnesses:start', 'refreshTasks:start'].includes(event.method)), [])
	await page.screenshot({ path: join(artifacts, 'recents-progressive-readiness-pending-20261006.png') })
	await release('ready', first)
	await expect(input).toBeEnabled()
	await expect(input).toHaveValue('DRAFT_A_MAIN')
	await waitEvent('harnesses:resolved', first, 1)
	await waitEvent('jobs:resolved', first, 1)
	await expect(page.getByRole('button', { name: 'Select model', exact: true })).toContainText('sample-balanced')
	await expect(page.getByRole('button', { name: 'Allow once', exact: true })).toBeEnabled()

	// Reopening known history can overlap metadata without treating it as admission.
	await page.getByRole('button', { name: 'Close tab Refine navigation', exact: true }).click()
	await expect(selectedTab('Refine navigation')).toHaveCount(0)
	await arm('history', first)
	await arm('providers', first)
	const reopenBoundary = (await events()).length - 1
	await recent('Refine navigation').click()
	await waitEvent('history:held', first, 2)
	await expect(transcript).toHaveAttribute('data-history-state', 'saved')
	await expect(transcript).toContainText(marker(first, 1))
	await expect(page.locator('.conversation-refresh')).toHaveText('Updating conversation…')
	await waitEvent('providers:held', first, 2)
	await page.waitForFunction(({ id, methods, start }) => methods.every((method) =>
		window.__recentsProof.events.some((event) => event.sessionId === id &&
			event.method === `${method}:start` && event.index > start)),
	{ id: first, methods: metadata, start: reopenBoundary })
	await blocked({ approval: true })
	const overlapping = (await events()).filter((event) => event.sessionId === first)
	assert.ok(metadata.every((method) => overlapping.some((event) => event.method === `${method}:start` && event.index > reopenBoundary)))
	assert.equal(overlapping.some((event) => event.method === 'history:resolved' && event.ordinal === 2), false)

	// Another project's cold Recents shell wins; obsolete A responses cannot write B.
	await arm('history', second)
	await arm('ready', second)
	await recent('Improve the quick start').click()
	await waitEvent('history:held', second, 1)
	await expect(selectedTab('Improve the quick start')).toHaveAttribute('aria-selected', 'true')
	await expect(transcript).toHaveAttribute('data-history-state', 'loading')
	await expect(transcript).not.toContainText(marker(first, 1))
	await blocked()
	await release('history', first)
	await release('providers', first)
	await waitEvent('history:resolved', first, 2)
	await waitEvent('providers:resolved', first, 2)
	await frames()
	await expect(selectedTab('Improve the quick start')).toHaveAttribute('aria-selected', 'true')
	await expect(transcript).toHaveAttribute('data-history-state', 'loading')
	await expect(transcript).not.toContainText(marker(first, 2))
	await expect(input).not.toHaveValue('DRAFT_A_MAIN')
	await release('history', second)
	await expect(transcript).toContainText(marker(second, 1))
	await waitEvent('ready:held', second, 1)
	await blocked({ approval: true })
	await release('ready', second)
	await expect(input).toBeEnabled()
	await expect(input).toHaveValue('DRAFT_B_MAIN')
	await expect(page.getByRole('button', { name: 'Select model', exact: true })).toContainText('sample-focused')
	await expect(selectedTab('Improve the quick start')).toHaveAttribute('aria-selected', 'true')
	await page.screenshot({ path: join(artifacts, 'recents-progressive-after-navigation-20261006.png') })

	// Readiness failure retains the accepted history and its draft but refuses admission.
	await arm('ready', third, 'reject')
	await recent('Polish empty states').click()
	await waitEvent('ready:held', third, 1)
	await expect(transcript).toContainText(marker(third, 1))
	await blocked({ approval: true })
	await release('ready', third)
	await expect(page.getByRole('alert')).toContainText(`Deferred ready failed for ${third}`)
	await expect(transcript).toContainText(marker(third, 1))
	await blocked({ approval: true })
	await page.screenshot({ path: join(artifacts, 'recents-progressive-readiness-error-20261006.png') })
	const catalogueBeforeRetry = (await events()).filter((event) => event.method === 'catalogue:start').length
	assert.equal(catalogueBeforeRetry, catalogueBefore, 'known Recents opens and close/reopen must not relist all projects')
	await page.getByRole('button', { name: 'Retry setup', exact: true }).click()
	await expect(input).toBeEnabled()
	await expect(input).toHaveValue('DRAFT_C_MAIN')
	await waitEvent('ready:resolved', third, 2)
	await expect(page.getByRole('alert')).toHaveCount(0)

	const final = await page.evaluate(() => ({
		events: structuredClone(window.__recentsProof.events),
		violations: structuredClone(window.__recentsProof.violations),
		actions: structuredClone(window.__recentsProof.actions),
	}))
	assert.deepEqual(final.violations, [])
	assert.deepEqual(final.actions, [])
	assert.deepEqual(faults, [])
	const catalogueAfter = final.events.filter((event) => event.method === 'catalogue:start').length
	assert.ok(catalogueAfter >= catalogueBeforeRetry, 'explicit Retry setup may authoritatively refresh the catalogue')
	const receipt = {
		passed: true,
		browserPreview: true,
		fixture: 'Existing ordinary sample Recents in two projects; history, registration and readiness are synthetic deferred API boundaries.',
		modelRequests: 0,
		providerRequests: 0,
		computerCalls: 0,
		externalRequests: 'aborted',
		checks: [
			'cold Recents click selects the shell and loading transcript before the held history resolves',
			'opening known Recents rows does not trigger another full project catalogue scan',
			'Opening conversation notice identifies pending first history; composer, model and send remain blocked',
			'no targeted session metadata or readiness read runs before main registration',
			'duplicate click on the same pending Recents row shares one history and one readiness flight',
			'authoritative messages paint while the readiness response remains explicitly held',
			'ancillary shell polling, engine discovery and duplicate visible-task reads wait until core admission completes',
			'composer, models, permission settings, plugins, engine selection, attachment import, approvals and queued-message mutations stay unavailable until readiness confirms',
			'confirmed closed-conversation reopen displays saved history and overlaps history with all four metadata reads',
			'rapid navigation to another project wins over obsolete history and provider results',
			'late A responses cannot replace B transcript, selected tab or owner-specific draft',
			'readiness failure retains accepted messages, blocks actions and allows an authoritative Retry setup',
			'synthetic per-session drafts and model settings are retained without provider selection or sending',
		],
		firstSession: first,
		secondSession: second,
		metadataMethods: metadata,
		catalogueCalls: { before: catalogueBefore, beforeExplicitRetry: catalogueBeforeRetry, afterExplicitRetry: catalogueAfter },
		events: final.events,
		violations: final.violations,
		actionCalls: final.actions,
		faults,
		fixtureLimits: 'In-memory Vite browser fixture; no native deployment, durable history, real CLI readiness or latency guarantee is established.',
	}
	await writeFile(join(artifacts, 'recents-progressive-browser-proof-20261006.json'), `${JSON.stringify(receipt, null, 2)}\n`)
	console.log(JSON.stringify({ passed: true, calls: final.events.length, violations: 0, actionCalls: 0 }))
} catch (error) {
	if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'recents-progressive-browser-failure-20261006.png') }).catch(() => {})
	console.error(JSON.stringify({ failed: true, message: error instanceof Error ? error.message : String(error), events: await events().catch(() => []) }))
	throw error
} finally {
	await browser.close()
}
