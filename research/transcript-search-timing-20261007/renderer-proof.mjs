/** Real Desktop renderer, actual SDK/CLI journal fixture and ACP mapping; no native/provider calls. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const artifacts = join(repo, 'research/transcript-search-timing-20261007/artifacts')
await mkdir(artifacts, { recursive: true })
const fixture = JSON.parse(await readFile(join(artifacts, 'journal-fixtures.json'), 'utf8'))
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const { chromium, expect } = require('@playwright/test')
const server = await createServer({ root: join(repo, 'packages/desktop'), server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false }, logLevel: 'error' })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const receipt = { passed: false, realDesktopRenderer: true, actualSdkJournalFixture: true, sourceAcpMapping: true, nativeActions: 0, providerRequests: 0, actualUserConversationRead: false, checks: [], measurements: [], referenceDifferences: [], screenshots: [], pageErrors: [], limits: ['Synthetic conversation only; no native application or provider prompt. Reference checks use supplied WAI DOM measurements, not a pixel-parity claim.'] }

function installFixture({ fixture, appearance }) {
	localStorage.setItem('namzu.appearance', appearance)
	localStorage.setItem('namzu.sidebar-collapsed', 'true')
	let api
	let revision = 200
	const baseTime = Date.parse(fixture.journalClock.user)
	Date.now = () => baseTime + 60_000
	const listeners = new Set()
	const calls = { histories: [], external: [] }
	const workspace = { windowId: 'timing-window', sequence: 0, homeGroupId: 'timing-group', layout: { version: 1, revision: 0, windows: [{ id: 'timing-window', focusedGroupId: 'timing-group', root: { kind: 'group', id: 'timing-group', tabs: ['sample-thread-1', 'sample-thread-2', 'sample-thread-3'], activeTabId: 'sample-thread-1' } }] } }
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
			workspace.sequence++; workspace.layout.revision++
			return structuredClone(workspace)
		}
		api.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
		for (const name of ['draft', 'saveDraft', 'attachments', 'draftSettings', 'saveDraftSettings'])
			api[name] = (owner, ...args) => base[name](owner.replace(/:workspace:.*$/, ''), ...args)
		api.openConversation = async (projectId, sessionId) => {
			await base.openConversation(projectId, sessionId)
			calls.histories.push(sessionId)
			const history = sessionId === 'sample-thread-1' ? fixture.coldHistory : sessionId === 'sample-thread-2' ? fixture.legacyHistory : { messages: [], partial: false }
			const { restoreHistoryWork } = await import('/src/shared/history-work.ts')
			const { emptyThread } = await import('/src/shared/projection.ts')
			return { ...structuredClone(history), thread: restoreHistoryWork(emptyThread(), structuredClone(history.messages), structuredClone(history.work)) }
		}
		api.openExternal = async url => { calls.external.push(url) }
		api.backgroundWorkStatuses = async () => ({})
		for (const name of ['send', 'startPalComputer', 'stopPalComputer', 'cancel'])
			api[name] = async () => { throw new Error('Native/provider action forbidden in transcript proof.') }
		window.__timingProof = {
			baseTime,
			calls: () => structuredClone(calls),
			emit(events) {
				for (const event of events) for (const listener of listeners)
					listener({ ...event, sessionId: 'sample-thread-3', projectId: 'sample-app', revision: ++revision })
			},
		}
	} })
}

async function settle(page) {
	await page.evaluate(async () => {
		await document.fonts.ready
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		await Promise.all(document.getAnimations().filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => animation.finished.catch(() => {})))
	})
}

const scenarios = [
	{ name: 'wide-dark', viewport: { width: 1280, height: 900 }, appearance: 'dark', reducedMotion: 'no-preference' },
	{ name: 'narrow-light', viewport: { width: 640, height: 720 }, appearance: 'light', reducedMotion: 'reduce' },
	{ name: 'minimum-dark', viewport: { width: 560, height: 640 }, appearance: 'dark', reducedMotion: 'reduce' },
]
let context
try {
	for (const scenario of scenarios) {
		context = await browser.newContext({ viewport: scenario.viewport, colorScheme: scenario.appearance, reducedMotion: scenario.reducedMotion, timezoneId: 'Europe/Istanbul' })
		await context.route('**/*', route => new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort())
		const page = await context.newPage()
		page.setDefaultTimeout(12_000)
		page.on('pageerror', error => receipt.pageErrors.push({ scenario: scenario.name, message: error.message }))
		await page.addInitScript(installFixture, { fixture, appearance: scenario.appearance })
		await page.goto(origin)
		await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
		await expect(page.getByText('Find RunPod H100 hourly prices and keep the source links.', { exact: true })).toBeVisible()
		const transcript = page.locator('.normal-transcript')
		const messageTimes = () => transcript.locator('.message .message-time').evaluateAll(elements => elements.map(element => ({ dateTime: (element.matches('time') ? element : element.querySelector('time'))?.getAttribute('datetime'), title: element.getAttribute('title') })))
		const expectedTimes = [fixture.journalClock.user, fixture.journalClock.answer]
		assert.deepEqual((await messageTimes()).map(time => time.dateTime), expectedTimes)
		assert.ok((await messageTimes()).every(time => time.title.startsWith('Recorded in conversation:')))
		const worked = transcript.locator('.activity-trigger')
		await expect(worked).toHaveCount(1)
		await worked.focus(); await page.keyboard.press('Enter')
		await expect(worked).toHaveAttribute('aria-expanded', 'true')
		await expect(worked).toHaveAttribute('aria-label', /^Worked for 4s/)
		assert.doesNotMatch(await worked.getAttribute('aria-label'), /Thinking/)
		const searchRow = transcript.locator('[data-tool-call-id="provider-hosted-web-search:0:provider-search-fixture"]')
		await expect(searchRow).toHaveAttribute('data-tool-state', 'completed')
		await expect(searchRow.locator('.tool-label')).toHaveText('Searched the web')
		assert.equal(await searchRow.locator('time').getAttribute('datetime'), fixture.journalClock.searchStarted)
		await searchRow.locator('.tool-trigger').click()
		await expect(searchRow.getByText('Web search: RunPod H100 GPU hourly pricing · 9 sources', { exact: true })).toBeVisible()
		await searchRow.locator('.tool-trigger').focus(); await page.keyboard.press('Enter')
		await expect(searchRow.locator('.tool-trigger')).toHaveAttribute('aria-expanded', 'false')
		const localAction = transcript.locator('[data-tool-call-id]').filter({ hasText: 'Read gpu-rates.txt' })
		await localAction.locator('.tool-trigger').click()
		await expect(localAction.getByText('Recorded fixture rate: review the primary source before acting.', { exact: true })).toBeVisible()
		await localAction.locator('.tool-trigger').focus(); await page.keyboard.press('Enter')
		await expect(localAction.locator('.tool-trigger')).toHaveAttribute('aria-expanded', 'false')
		const lookups = transcript.locator('.tool-group')
		await expect(lookups).toHaveCount(1)
		await expect(lookups.locator(':scope > .tool-trigger .tool-label')).toHaveText('Checked earlier messages')
		await lookups.locator(':scope > .tool-trigger').click()
		for (const receipt of fixture.technicalReceipts) {
			const row = transcript.locator(`[data-tool-call-id="${receipt.toolUseId}"]`)
			await expect(row.locator('.tool-label')).toHaveText('Checked earlier messages')
			await row.locator('.tool-trigger').click()
			await expect(row.getByText(receipt.receipt, { exact: true })).toBeVisible()
			await row.locator('.tool-trigger').click()
		}
		await lookups.locator(':scope > .tool-trigger').click()
		await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).hover()
		await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).focus()
		await settle(page)
		const primaryRows = await transcript.locator('.activity-entries .tool-trigger').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).map(element => ({ label: element.querySelector('.tool-label')?.textContent, top: element.getBoundingClientRect().top, height: element.getBoundingClientRect().height, status: [...element.querySelectorAll('.tool-status')].map(child => ({ text: child.textContent, clip: getComputedStyle(child).clip, opacity: getComputedStyle(child).opacity })), clockOpacity: [...element.querySelectorAll('.message-time')].map(child => getComputedStyle(child).opacity), visibleDuration: [...element.querySelectorAll('.tool-duration')].some(child => getComputedStyle(child).opacity !== '0' && getComputedStyle(child).clip === 'auto') })))
		const rowIntervals = primaryRows.slice(1).map((row, index) => row.top - primaryRows[index].top)
		receipt.measurements.push({ scenario: scenario.name, primaryRows, rowIntervals })
		const primaryScreenshot = `primary-summary-${scenario.name}.png`
		await page.screenshot({ path: join(artifacts, primaryScreenshot) }); receipt.screenshots.push(primaryScreenshot)
		for (const row of primaryRows) {
			assert.doesNotMatch(row.label ?? '', /web_search|flexprice|search_conversation|Actions completed/)
			for (const clock of row.clockOpacity) assert.equal(clock, '0')
			for (const status of row.status) assert.ok(status.opacity === '0' || status.clip !== 'auto', `Routine ${status.text} status stays visually quiet`)
			assert.equal(row.visibleDuration, false)
		}
		for (const interval of rowIntervals) assert.equal(interval, 32)
		const disclosureHeight = () => transcript.locator('.turn-activity > [data-slot="collapsible-panel"]').first().evaluateAll(elements => elements[0]?.getBoundingClientRect().height ?? 0)
		const expandedHeight = await disclosureHeight()
		assert.ok(expandedHeight > 0)
		await worked.focus(); await page.keyboard.press('Enter'); await settle(page)
		await expect(worked).toHaveAttribute('aria-expanded', 'false')
		assert.equal(await disclosureHeight(), 0)
		await page.keyboard.press('Enter'); await settle(page)
		await expect(worked).toHaveAttribute('aria-expanded', 'true')
		assert.equal(await disclosureHeight(), expandedHeight)
		await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).focus()
		await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).hover()
		const hoverMeasurements = []
		for (const [name, trigger, clock] of [
			['completed search', searchRow.locator('.tool-trigger'), searchRow.locator('.message-time')],
			['settled work header', worked, worked.locator('.message-time')],
		]) {
			const measure = () => trigger.evaluate(element => { const chevron = element.querySelector('.disclosure-chevron'); const bounds = element.getBoundingClientRect(); const arrow = chevron?.getBoundingClientRect(); const point = arrow && document.elementFromPoint(arrow.x + arrow.width / 2, arrow.y + arrow.height / 2); return { trigger: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, chevron: arrow && { x: arrow.x, y: arrow.y, width: arrow.width, height: arrow.height }, pointerTarget: point?.tagName, pointerButtonLabel: point?.closest('button')?.getAttribute('aria-label') ?? point?.closest('button')?.getAttribute('title') } })
			const before = await measure()
			await trigger.hover(); await settle(page)
			const hovered = await measure()
			await clock.hover(); await settle(page)
			const overClock = await measure()
			assert.equal(hovered.chevron.x, before.chevron.x)
			assert.equal(overClock.chevron.x, before.chevron.x)
			assert.deepEqual(hovered.trigger, before.trigger)
			assert.deepEqual(overClock.trigger, before.trigger)
			hoverMeasurements.push({ name, before, hovered, overClock })
			await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).hover()
		}
		receipt.measurements.push({ scenario: scenario.name, expandedHeight, collapsedHeight: 0, hoverMeasurements })
		const userClock = transcript.locator('.message.user .message-time')
		await expect(userClock).toHaveAttribute('aria-label', /^Recorded in conversation:/)
		await userClock.focus()
		await expect(userClock).toHaveCSS('opacity', '1')
		const fullClock = (await userClock.getAttribute('title')).replace('Recorded in conversation: ', '')
		await userClock.click()
		await expect(userClock).toHaveAttribute('aria-pressed', 'true')
		await expect(userClock.locator('time')).toHaveText(fullClock)
		assert.equal(await userClock.locator('time').getAttribute('datetime'), fixture.journalClock.user)
		await userClock.click()
		await expect(userClock).toHaveAttribute('aria-pressed', 'false')
		await searchRow.locator('.tool-trigger').focus()
		await expect(searchRow.locator('.message-time')).toHaveCSS('opacity', '1')
		await expect(searchRow.locator('.tool-trigger button')).toHaveCount(0)
		await lookups.locator(':scope > .tool-trigger').click()
		const revealedTiming = []
		for (const receipt of fixture.technicalReceipts) {
			const row = transcript.locator(`[data-tool-call-id="${receipt.toolUseId}"]`)
			await row.locator('.tool-trigger').focus()
			await expect(row.locator('.message-time')).toHaveCSS('opacity', '1')
			await expect(row.locator('.tool-duration')).toHaveCSS('opacity', '1')
			await expect(row.locator('.tool-duration')).toHaveText(`${receipt.durationMs} ms`)
			await expect(row.locator('.tool-duration')).toHaveAttribute('aria-label', `Duration: ${receipt.durationMs} ms`)
			assert.equal(await row.locator('time').getAttribute('datetime'), receipt.startedAt)
			revealedTiming.push({ query: receipt.query, time: await row.locator('time').getAttribute('datetime'), duration: await row.locator('.tool-duration').textContent(), description: await row.locator('.tool-duration').getAttribute('aria-label') })
		}
		receipt.measurements.push({ scenario: scenario.name, revealedTiming })
		await lookups.locator(':scope > .tool-trigger').click()
		await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).focus()
		await settle(page)
		const geometry = await transcript.evaluate(element => {
			const trigger = element.querySelector('.activity-trigger')
			const row = element.querySelector('[data-tool-call-id] .tool-trigger')
			const entries = element.querySelector('.activity-entries')
			const style = trigger && getComputedStyle(trigger)
			const railStyle = entries && getComputedStyle(entries)
			const bounds = element.getBoundingClientRect()
			const toolRows = [...element.querySelectorAll('[data-tool-call-id] .tool-trigger')].map(row => ({ right: row.getBoundingClientRect().right, width: row.getBoundingClientRect().width, parents: [row.parentElement, row.parentElement?.parentElement].map(parent => ({ className: parent?.getAttribute('class'), right: parent?.getBoundingClientRect().right, width: parent?.getBoundingClientRect().width, minWidth: parent && getComputedStyle(parent).minWidth, display: parent && getComputedStyle(parent).display })), children: [...row.children].map(child => ({ className: child.getAttribute('class'), right: child.getBoundingClientRect().right, width: child.getBoundingClientRect().width, minWidth: getComputedStyle(child).minWidth, flexShrink: getComputedStyle(child).flexShrink })) }))
			return { triggerHeight: trigger?.getBoundingClientRect().height, triggerFont: style?.fontSize, triggerLineHeight: style?.lineHeight, triggerGap: style?.gap, rowHeight: row?.getBoundingClientRect().height, railPadding: railStyle?.paddingLeft, railMargin: railStyle?.marginLeft, railBorder: railStyle?.borderLeftWidth, rowCount: element.querySelectorAll('[data-tool-call-id]').length, nestedToolGroups: element.querySelectorAll('.tool-group').length, horizontalOverflow: element.scrollWidth > element.clientWidth + 1, toolRows, transcriptBounds: { left: bounds.left, right: bounds.right, width: bounds.width }, viewportWidth: innerWidth, ancestorWidths: ['.workspace-canvas', '.workspace', '.chat-stage', '.transcript'].map(selector => { const parent = element.closest(selector); return { selector, width: parent?.getBoundingClientRect().width, minWidth: parent && getComputedStyle(parent).minWidth } }), viewportClipped: bounds.left < -1 || bounds.right > innerWidth + 1 }
		})
		receipt.measurements.push({ scenario: scenario.name, ...geometry })
		assert.equal(geometry.nestedToolGroups, 1)
		assert.equal(geometry.triggerHeight, 32)
		assert.equal(geometry.triggerFont, '14px')
		if (geometry.triggerLineHeight !== '20px') receipt.referenceDifferences.push({ scenario: scenario.name, property: 'activity disclosure line-height', actual: geometry.triggerLineHeight, expected: '20px' })
		assert.equal(geometry.triggerGap, '8px')
		assert.equal(geometry.rowHeight, 32)
		assert.equal(geometry.railPadding, '16px')
		assert.equal(geometry.railMargin, '7px')
		assert.equal(geometry.railBorder, '1px')
		assert.equal(geometry.horizontalOverflow, false)
		if (geometry.viewportClipped) receipt.referenceDifferences.push({ scenario: scenario.name, property: 'transcript viewport fit', actual: geometry.transcriptBounds, expected: `within 0..${geometry.viewportWidth}px` })
		for (const row of geometry.toolRows) {
			if (row.right > geometry.transcriptBounds.right + 1) receipt.referenceDifferences.push({ scenario: scenario.name, property: 'tool row fit', actual: row, expected: `within transcript right ${geometry.transcriptBounds.right}px` })
			for (const child of row.children) assert.ok(child.right <= row.right + 1, `${child.className} exceeds tool row`)
		}
		const originalUrl = page.url()
		await transcript.getByRole('link', { name: 'RunPod pricing', exact: true }).click()
		assert.deepEqual((await page.evaluate(() => window.__timingProof.calls())).external, ['https://www.runpod.io/pricing'])
		assert.equal(page.url(), originalUrl)
		const inlineSource = 'https://docs.runpod.io/serverless/overview'
		const inlineLink = transcript.getByRole('link', { name: inlineSource, exact: true })
		await expect(inlineLink).toHaveCount(1)
		assert.ok(await inlineLink.evaluate(element => Boolean(element.closest('code') || element.querySelector('code'))), 'Sole inline URL preserves code markup')
		await inlineLink.click()
		assert.deepEqual((await page.evaluate(() => window.__timingProof.calls())).external, ['https://www.runpod.io/pricing', inlineSource])
		assert.equal(page.url(), originalUrl)
		await expect(transcript.locator('pre').getByRole('link')).toHaveCount(0)
		await expect(transcript.locator('pre code').getByText('https://www.runpod.io/console', { exact: true })).toBeVisible()
		for (const code of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.invalid/', 'curl https://example.invalid/api']) {
			await expect(transcript.getByRole('link', { name: code, exact: true })).toHaveCount(0)
			await expect(transcript.locator('code').getByText(code, { exact: true })).toBeVisible()
		}
		for (const label of ['Local file', 'Script', 'Credentials']) {
			await expect(transcript.getByRole('link', { name: label, exact: true })).toHaveCount(0)
			await expect(transcript.getByText(label, { exact: true })).toBeVisible()
		}
		const screenshot = `transcript-${scenario.name}.png`
		await page.screenshot({ path: join(artifacts, screenshot) }); receipt.screenshots.push(screenshot)
		await page.getByRole('tab', { name: 'Namzu: Polish empty states', exact: true }).click()
		await expect(page.getByText('Keep its clock unknown.', { exact: true })).toBeVisible()
		await expect(transcript.locator('time')).toHaveCount(0)
		await page.getByRole('tab', { name: 'Namzu: Refine navigation', exact: true }).click()
		await expect(page.getByText('Find RunPod H100 hourly prices and keep the source links.', { exact: true })).toBeVisible()
		assert.deepEqual((await messageTimes()).map(time => time.dateTime), expectedTimes)
		await page.getByRole('button', { name: 'Close tab Refine navigation', exact: true }).click()
		await page.keyboard.press('Control+b')
		await page.locator('.sidebar-project-navigation').getByRole('button', { name: 'Refine navigation', exact: true }).click()
		assert.deepEqual((await messageTimes()).map(time => time.dateTime), expectedTimes)
		if (await page.getByRole('button', { name: 'Close sidebar', exact: true }).isVisible())
			await page.getByRole('button', { name: 'Close sidebar', exact: true }).click()
		else if (await page.locator('.sidebar-project-navigation').isVisible())
			await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click()
		await page.getByRole('tab', { name: 'Namzu: Review message settings', exact: true }).click()
		const baseTime = Date.parse(fixture.journalClock.user)
		await page.evaluate(({ baseTime, pending }) => window.__timingProof.emit([
			{ kind: 'prompt', prompt: 'Compare H100 rates using primary sources.', at: baseTime + 12_000 },
			{ kind: 'state', running: true, queued: [], at: baseTime + 12_000 },
			{ kind: 'update', at: baseTime + 12_100, update: { kind: 'agent_thought', blockId: 'fixture-thought', status: 'pending' } },
			{ kind: 'update', at: baseTime + 12_200, update: { kind: 'agent_thought_chunk', blockId: 'fixture-thought', text: 'I will check the current primary pricing source.' } },
		]), { baseTime, pending: fixture.livePending })
		await expect(transcript.locator('.working[data-transcript-phase="thinking"]')).toBeVisible()
		await expect(transcript.locator('.activity-trigger')).toHaveAttribute('aria-label', 'Thinking · 48s')
		await expect(transcript.locator('.working')).toHaveClass(/transcript-status-only/)
		await page.evaluate(({ baseTime, pending }) => window.__timingProof.emit([{ kind: 'update', at: baseTime + 13_000, update: pending }]), { baseTime, pending: fixture.livePending })
		await expect(transcript.locator('.working[data-transcript-phase="tools"]')).toBeVisible()
		await expect(transcript.locator('.activity-trigger')).toHaveAttribute('aria-label', 'Working · 48s')
		const liveSearch = transcript.locator('[data-tool-call-id="provider-hosted-web-search:0:provider-search-fixture"]')
		await expect(liveSearch).toHaveAttribute('data-tool-state', 'running')
		await expect(liveSearch.locator('.tool-label')).toHaveText('Searching the web')
		await expect(liveSearch.getByText('9 sources', { exact: false })).toHaveCount(0)
		await page.evaluate(({ baseTime, lookups }) => window.__timingProof.emit(lookups.map((lookup, index) => ({ kind: 'update', at: baseTime + 14_000 + index * 100, update: lookup.pendingUpdate }))), { baseTime, lookups: fixture.technicalReceipts })
		await expect(transcript.locator('.tool-group > .tool-trigger .tool-label')).toHaveText('Checking earlier messages')
		await page.evaluate(({ baseTime, complete, lookups }) => window.__timingProof.emit([
			...lookups.map((lookup, index) => ({ kind: 'update', at: baseTime + 57_000 + index * 100, update: lookup.completedUpdate })),
			{ kind: 'update', at: baseTime + 58_000, update: complete },
			{ kind: 'update', at: baseTime + 59_000, update: { kind: 'agent_message_chunk', messageId: 'fixture-live-answer', text: 'Found the current ' } },
			{ kind: 'update', at: baseTime + 59_500, update: { kind: 'agent_message_chunk', messageId: 'fixture-live-answer', text: 'primary source.' } },
			{ kind: 'update', at: baseTime + 60_000, update: { kind: 'agent_message', messageId: 'fixture-live-answer', status: 'completed', content: 'Found the current primary source.', stopReason: 'end_turn' } },
			{ kind: 'update', at: baseTime + 60_000, update: { kind: 'turn_ended', stopReason: 'end_turn' } },
		]), { baseTime, complete: fixture.liveCompleted, lookups: fixture.technicalReceipts })
		await expect(transcript.getByText('Found the current primary source.', { exact: true })).toBeVisible()
		await expect(transcript.locator('.working[aria-hidden="false"]')).toHaveCount(0)
		const liveMessageTime = transcript.locator('.message.assistant .message-time')
		assert.equal(await liveMessageTime.locator('time').getAttribute('datetime'), new Date(baseTime + 59_000).toISOString())
		assert.ok((await liveMessageTime.getAttribute('title')).startsWith('Observed by Namzu:'))
		await expect(transcript.locator('.activity-trigger')).toHaveAttribute('aria-label', /^Worked for 48s/)
		assert.doesNotMatch(await transcript.locator('.activity-trigger').getAttribute('aria-label'), /Thinking/)
		await transcript.locator('.activity-trigger').click()
		await expect(liveSearch).toHaveAttribute('data-tool-state', 'completed')
		await expect(liveSearch.locator('.tool-label')).toHaveText('Searched the web')
		assert.equal(await liveSearch.locator('time').getAttribute('datetime'), new Date(baseTime + 13_000).toISOString())
		const liveLookups = transcript.locator('.tool-group')
		await expect(liveLookups.locator(':scope > .tool-trigger .tool-label')).toHaveText('Checked earlier messages')
		await liveLookups.locator(':scope > .tool-trigger').click()
		for (const receipt of fixture.technicalReceipts) {
			const row = transcript.locator(`[data-tool-call-id="${receipt.toolUseId}"]`)
			await row.locator('.tool-trigger').click()
			await expect(row.locator('.tool-content').getByText(receipt.query, { exact: true })).toBeVisible()
			await expect(row.getByText(receipt.receipt, { exact: true })).toBeVisible()
			await row.locator('.tool-trigger').click()
		}
		await liveLookups.locator(':scope > .tool-trigger').click()
		await settle(page)
		await expect(transcript.locator('.activity-trigger .transcript-phase-text')).toHaveText(/^Worked for 48s/)
		assert.doesNotMatch(await transcript.locator('.activity-trigger .transcript-phase-text').textContent(), /Thinking/)
		if (scenario.reducedMotion === 'reduce') assert.equal(await transcript.locator('[data-slot="collapsible-panel"]').first().evaluate(element => getComputedStyle(element).transitionDuration), '0s')
		receipt.checks.push(`${scenario.name}: journal clocks persist across navigation/close/reopen; legacy clocks stay absent; WAI rail/disclosure metrics and keyboard interaction; primary summaries have human phrases, quiet completion/timing, no raw query/tool names or Actions completed; actual queries/results remain in explicit details; Markdown and sole inline-code source bridges each once without renderer navigation; fenced URL/command/hostile links inert; hosted Web search pending/completed; completed header never Thinking; live first-observation clock retained through terminal settlement`)
		await context.close(); context = undefined
	}
	assert.deepEqual(receipt.pageErrors, [])
	assert.deepEqual(receipt.referenceDifferences, [])
	receipt.passed = true
} finally {
	await context?.close(); await browser.close(); await server.close()
	await writeFile(join(artifacts, 'renderer-proof.json'), `${JSON.stringify(receipt, null, 2)}\n`)
}
if (!receipt.passed) process.exitCode = 1
console.log(JSON.stringify({ passed: receipt.passed, checks: receipt.checks.length, pageErrors: receipt.pageErrors.length }))
