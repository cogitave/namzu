/** Browser-only proof for the Pal settings icon and Communication dialog.
 * Uses the Vite design preview, in-memory Pal/sample data and an injected fake
 * communication API. No native application, model, provider or computer calls.
 */
import assert from 'node:assert/strict'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const origin = process.env.NAMZU_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5173/preview'
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1024, height: 900 }, colorScheme: 'dark' })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const faults = []
let palTranscriptScroll
async function settleCardMotion(card) {
	await card.evaluate(async (element) => {
		const finite = element.getAnimations({ subtree: true }).filter((animation) => {
			const endTime = animation.effect?.getComputedTiming().endTime
			return animation.playState === 'running' && typeof endTime === 'number' && Number.isFinite(endTime)
		})
		await Promise.all(finite.map((animation) => animation.finished.catch(() => {})))
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	})
}
page.on('pageerror', (error) => faults.push(error.message))
await context.route('**/*', (route) =>
	new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort(),
)
await mkdir(artifacts, { recursive: true })

try {
	await page.addInitScript(() => {
		let api
		const listeners = new Set()
		const palSessions = new Set()
		const tasks = [
			{ taskId: 'fixture-task-plan', subject: 'Review the Communication panel at narrow widths', status: 'in_progress', blockedBy: [] },
			{ taskId: 'fixture-task-dependency', subject: 'Confirm the peer message receipt', status: 'pending', blockedBy: ['fixture-task-plan'] },
		]
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
			set: (value) => {
				api = value
				api.workspace = async () => structuredClone(workspace)
				api.workspaceAction = async (action) => {
					const group = workspace.layout.windows[0].root
					if (action.kind === 'open' || action.kind === 'activate') {
						if (!group.tabs.includes(action.tabId)) group.tabs.push(action.tabId)
						group.activeTabId = action.tabId
						workspace.layout.revision++
						workspace.sequence++
					}
					return structuredClone(workspace)
				}
				api.onEvent = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
				const newConversation = api.newConversation.bind(api)
				api.newConversation = async (projectId) => {
					const result = await newConversation(projectId)
					if ((await api.projects()).some((project) => project.id === projectId && project.palId))
						palSessions.add(result.id)
					return result
				}
				const openConversation = api.openConversation.bind(api)
				api.openConversation = async (projectId, sessionId) => {
					const history = await openConversation(projectId, sessionId)
					if (!palSessions.has(sessionId)) return { ...history, thread: { tasks: structuredClone(tasks) } }
					const transcriptMessages = Array.from({ length: 18 }, (_, index) => {
						const turn = index + 1
						return [
							{ role: 'user', text: `Preview transcript user message ${String(turn).padStart(2, '0')}.` },
							{ role: 'assistant', status: 'completed', phase: 'final_answer', text: turn === 18
								? 'Pal scroll proof final message marker.'
								: Array.from({ length: 9 }, (_, line) => `Preview transcript segment ${String(turn).padStart(2, '0')} · line ${line + 1}: this fixture text verifies scrolling without using real conversation content.`).join('\n\n') },
						]
					}).flat()
					const timeline = transcriptMessages.map((message, index) => ({
						kind: 'message', index, turn: Math.floor(index / 2) + 1,
					}))
					return {
						...history,
						messages: structuredClone(transcriptMessages),
						thread: {
							tasks: structuredClone(tasks), messages: structuredClone(transcriptMessages), timeline,
							turn: 18, turns: {}, running: false, queued: [], queuedItems: [],
							activeToolIds: [], permissions: [], tools: {}, reasoning: {}, responding: false,
						},
					}
				}
				api.refreshTasks = async (sessionId) => {
					for (const listener of listeners)
						listener({ kind: 'tasks', sessionId, tasks: structuredClone(tasks) })
				}
				window.__palSettingsProof = { mode: 'success', reads: [] }
				api.palCommunication = async (_sessionId, palId) => {
					const state = window.__palSettingsProof
					state.reads.push({ palId, mode: state.mode })
					if (state.mode === 'failed') throw new Error('PRIVATE fixture read failure')
					const peers = [{
						palId: 'fixture-kiro', name: 'Kiro', paused: false,
						outgoing: { revision: 1, enabled: true, allowWake: false },
						incoming: { revision: 1, enabled: true, allowWake: false },
					}]
					const sources = [
						{ palId, name: 'Sıtkı', conversations: [{ id: 'fixture-source-one', title: 'Sıtkı plan', profileRevision: 1 }] },
						{ palId: 'fixture-kiro', name: 'Kiro', conversations: [{ id: 'fixture-source-two', title: 'Kiro plan', profileRevision: 2 }] },
					]
					return {
						v: 1, palId, snapshotId: `fixture-snapshot-${state.reads.length}`,
						supported: state.mode !== 'unsupported', peers,
						messages: [{ id: 'fixture-message-1', status: 'pending', sourceKind: 'pal', sourcePalId: 'fixture-kiro', body: 'PRIVATE fixture message body' }],
						subscriptions: [], sources,
					}
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
	const transcript = page.getByRole('region', { name: 'Sıtkı conversation', exact: true })
	await expect(transcript).toBeVisible()
	await expect(transcript.locator('.pal-chat-message').last()).toContainText('Pal scroll proof final message marker.')
	const transcriptStart = await transcript.evaluate((element) => {
		const rect = element.getBoundingClientRect()
		const ancestors = []
		for (let parent = element.parentElement; parent; parent = parent.parentElement)
			ancestors.push({ top: parent.scrollTop, left: parent.scrollLeft })
		return {
			top: element.scrollTop, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
			width: element.scrollWidth, clientWidth: element.clientWidth,
			style: {
				overflowY: getComputedStyle(element).overflowY,
				scrollbarWidth: getComputedStyle(element).scrollbarWidth,
				scrollbarGutter: getComputedStyle(element).scrollbarGutter,
				webkitScrollbar: getComputedStyle(element, '::-webkit-scrollbar').display,
			},
			rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
			ancestors, outer: { x: scrollX, y: scrollY, width: document.documentElement.scrollWidth, clientWidth: innerWidth },
		}
	})
	assert.ok(transcriptStart.scrollHeight > transcriptStart.clientHeight, 'long Pal transcript fixture must overflow vertically')
	assert.equal(transcriptStart.style.overflowY, 'auto')
	assert.equal(transcriptStart.style.scrollbarWidth, 'none')
	assert.equal(transcriptStart.style.scrollbarGutter, 'auto')
	assert.equal(transcriptStart.style.webkitScrollbar, 'none')
	assert.ok(transcriptStart.outer.width <= transcriptStart.outer.clientWidth, 'no horizontal page overflow')
	const originalTranscriptScrollTop = transcriptStart.top
	await transcript.evaluate((element) => { element.scrollTop = 0 })
	await transcript.hover()
	const wheelScroll = transcript.evaluate((element) => new Promise((resolve) => {
		element.addEventListener('scroll', () => resolve(element.scrollTop), { once: true, passive: true })
	}))
	await page.mouse.wheel(0, 420)
	const wheelScrollTop = await wheelScroll
	assert.ok(wheelScrollTop > 0, 'wheel input should scroll the actual Pal transcript element')
	await transcript.evaluate((element) => { element.scrollTop = 0 })
	await transcript.focus()
	const pageDownScroll = transcript.evaluate((element) => new Promise((resolve) => {
		element.addEventListener('scrollend', () => resolve(element.scrollTop), { once: true, passive: true })
	}))
	await page.keyboard.press('PageDown')
	const pageDownScrollTop = await pageDownScroll
	assert.ok(pageDownScrollTop >= Math.min(100, transcriptStart.rect.height * 0.25), 'PageDown should meaningfully scroll the keyboard-focused Pal transcript region')
	const lastMessage = transcript.locator('.pal-chat-message').last()
	await lastMessage.scrollIntoViewIfNeeded()
	await expect(lastMessage).toBeInViewport({ ratio: 0.5 })
	const lastMessageScrollTop = await transcript.evaluate((element) => element.scrollTop)
	const outerAfterScroll = await transcript.evaluate(() => ({ x: scrollX, y: scrollY, width: document.documentElement.scrollWidth, clientWidth: innerWidth }))
	assert.deepEqual(outerAfterScroll, transcriptStart.outer, 'transcript wheel/keyboard scroll must not move or widen the outer page')
	const cardScrollbarWidth = await card.evaluate((element) => getComputedStyle(element).scrollbarWidth)
	assert.notEqual(cardScrollbarWidth, 'none', 'card scrollbar must remain available')
	palTranscriptScroll = {
		css: transcriptStart.style,
		scrollRange: transcriptStart.scrollHeight - transcriptStart.clientHeight,
		wheelScrollTop, pageDownScrollTop, lastMessageScrollTop,
		outerUnchanged: true, cardScrollbarWidth,
	}
	await page.screenshot({ path: join(artifacts, 'pal-settings-transcript-hidden-scrollbar-20261006.png') })
	await transcript.evaluate((element, value) => { element.scrollTo({ top: value, behavior: 'instant' }) }, originalTranscriptScrollTop)
	await expect(lastMessage).toContainText('Pal scroll proof final message marker.')
	const trigger = card.getByRole('button', { name: 'Sıtkı settings', exact: true })
	await expect(trigger).toHaveAttribute('aria-haspopup', 'dialog')
	await expect(card.locator('.pal-communication-entry')).toHaveCount(0)
	const palTasks = card.getByRole('region', { name: 'Sıtkı tasks', exact: true })
	await expect(palTasks).toContainText('Review the Communication panel at narrow widths')
	await expect(palTasks).toContainText('Depends on: Review the Communication panel at narrow widths')
	await settleCardMotion(card)
	const cardBoundsBeforeTaskOpen = await card.boundingBox()
	const scrollBeforeTaskOpen = await card.evaluate((element) => {
		const values = []
		for (let parent = element.parentElement; parent; parent = parent.parentElement)
			values.push({ scrollTop: parent.scrollTop, scrollLeft: parent.scrollLeft })
		return values
	})
	await page.getByRole('button', { name: /Tasks · 0\/2 completed/ }).click()
	await expect(page.locator('.jobs-panel[data-open="false"]')).toHaveCount(1)
	await expect(palTasks).toBeFocused()
	await expect(card).toBeVisible()
	await settleCardMotion(card)
	const cardBoundsAfterTaskOpen = await card.boundingBox()
	const scrollAfterTaskOpen = await card.evaluate((element) => {
		const values = []
		for (let parent = element.parentElement; parent; parent = parent.parentElement)
			values.push({ scrollTop: parent.scrollTop, scrollLeft: parent.scrollLeft })
		return values
	})
	for (const key of ['x', 'y', 'width', 'height'])
		assert.ok(Math.abs(cardBoundsAfterTaskOpen[key] - cardBoundsBeforeTaskOpen[key]) <= 1, `${key} shifted: ${cardBoundsBeforeTaskOpen[key]} → ${cardBoundsAfterTaskOpen[key]}`)
	assert.deepEqual(scrollAfterTaskOpen, scrollBeforeTaskOpen, 'focusing Pal tasks should not scroll outer workspace ancestors')
	const profileToggle = page.getByRole('button', { name: 'Hide Sıtkı profile', exact: true })
	await profileToggle.click()
	await expect(card).toHaveCount(0)
	await page.getByRole('button', { name: /Tasks · 0\/2 completed/ }).click()
	await expect(card).toBeVisible()
	await expect(palTasks).toBeFocused()
	await expect(page.locator('.jobs-panel[data-open="false"]')).toHaveCount(1)
	await expect(page.getByRole('button', { name: 'Hide Sıtkı profile', exact: true })).toBeVisible()
	await card.getByRole('button', { name: 'Sıtkı settings', exact: true }).focus()
	await page.keyboard.press('Escape')
	await expect(card).toBeVisible()

	const widths = []
	for (const width of [1024, 1188]) {
		await page.setViewportSize({ width, height: 900 })
		await expect(card).toBeVisible()
		await settleCardMotion(card)
		const geometry = await page.evaluate(() => {
			const card = document.querySelector('.pal-context-card')
			const avatar = document.querySelector('.pal-context-avatar')
			const settings = document.querySelector('.pal-context-settings')
			const rect = (node) => {
				const { x, y, width, height, right, bottom } = node.getBoundingClientRect()
				return { x, y, width, height, right, bottom }
			}
			return { card: rect(card), avatar: rect(avatar), settings: rect(settings), overflow: document.documentElement.scrollWidth > innerWidth }
		})
		assert.equal(geometry.overflow, false)
		assert.ok(geometry.settings.x >= geometry.avatar.x + geometry.avatar.width)
		assert.ok(geometry.settings.right <= geometry.card.right - 12)
		if (width === 1024) assert.ok(geometry.card.width >= 240 && geometry.card.width <= 246)
		if (width === 1188) assert.ok(geometry.card.width >= 264 && geometry.card.width <= 324, `300px target card width was ${geometry.card.width}`)
		widths.push({ viewportWidth: width, ...geometry })
		await page.screenshot({ path: join(artifacts, `pal-settings-card-${width}-20261005.png`) })
	}
	await page.setViewportSize({ width: 1188, height: 420 })
	await settleCardMotion(card)
	const shortCard = await card.evaluate((element) => ({
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
		maxHeight: getComputedStyle(element).maxHeight,
	}))
	assert.ok(shortCard.scrollHeight > shortCard.clientHeight, 'short viewport should bound the Pal card and allow internal scrolling')
	const dependency = palTasks.getByText('Depends on: Review the Communication panel at narrow widths', { exact: true })
	await dependency.scrollIntoViewIfNeeded()
	await expect(dependency).toBeInViewport({ ratio: 0.5 })
	assert.ok(await card.evaluate((element) => element.scrollTop > 0), 'dependency detail should be reachable by scrolling inside the Pal card')
	await page.screenshot({ path: join(artifacts, 'pal-settings-card-short-height-20261005.png') })
	await page.setViewportSize({ width: 1188, height: 900 })
	await settleCardMotion(card)

	await trigger.click()
	const dialog = page.getByRole('dialog', { name: 'Sıtkı settings', exact: true })
	await expect(dialog).toBeVisible()
	await expect(dialog.getByText('Communication', { exact: true })).toBeVisible()
	await expect(dialog.getByRole('tab', { name: 'Peers', exact: true })).toBeVisible()
	await expect(dialog.getByRole('checkbox', { name: 'Allow Sıtkı to message Kiro', exact: true })).toBeEnabled()
	await expect(dialog).not.toContainText('PRIVATE')
	await dialog.getByRole('tab', { name: 'Inbox', exact: true }).focus()
	await page.keyboard.press('ArrowRight')
	await expect(dialog.getByRole('tab', { name: 'Activity subscriptions', exact: true })).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(dialog.getByRole('tab', { name: 'Activity subscriptions', exact: true })).toHaveAttribute('aria-selected', 'true')
	await page.keyboard.press('ArrowLeft')
	await expect(dialog.getByRole('tab', { name: 'Inbox', exact: true })).toBeFocused()
	await page.keyboard.press('Enter')
	await expect(dialog.getByRole('tab', { name: 'Inbox', exact: true })).toHaveAttribute('aria-selected', 'true')
	await expect(dialog).toContainText('Accepted · awaiting delivery')
	await page.screenshot({ path: join(artifacts, 'pal-settings-communication-inbox-20261005.png') })
	await page.keyboard.press('Escape')
	await expect(dialog).toHaveCount(0)
	await expect(trigger).toBeFocused()

	await trigger.click()
	await expect(dialog).toBeVisible()
	await dialog.getByRole('button', { name: 'Close Pal settings', exact: true }).click()
	await expect(dialog).toHaveCount(0)
	await expect(trigger).toBeFocused()

	await page.evaluate(() => { window.__palSettingsProof.mode = 'success' })
	await trigger.click()
	await expect(dialog).toBeVisible()
	await expect(dialog).toContainText('Kiro')
	await page.evaluate(() => { window.__palSettingsProof.mode = 'failed' })
	await dialog.getByRole('button', { name: 'Refresh communication', exact: true }).click()
	await expect(dialog.getByRole('alert')).toContainText('Communication is unavailable')
	await expect(dialog).toContainText('Kiro')
	await expect(dialog.getByRole('checkbox', { name: 'Allow Sıtkı to message Kiro', exact: true })).toBeDisabled()
	await expect(dialog).not.toContainText('PRIVATE')
	await page.screenshot({ path: join(artifacts, 'pal-settings-failed-read-20261005.png') })
	await page.evaluate(() => { window.__palSettingsProof.mode = 'success' })
	await dialog.getByRole('button', { name: 'Refresh communication', exact: true }).click()
	await expect(dialog.getByRole('alert')).toHaveCount(0)
	await expect(dialog.getByRole('checkbox', { name: 'Allow Sıtkı to message Kiro', exact: true })).toBeEnabled()
	await page.keyboard.press('Escape')
	await expect(dialog).toHaveCount(0)
	await expect(trigger).toBeFocused()

	await page.evaluate(() => { window.__palSettingsProof.mode = 'unsupported' })
	await trigger.click()
	await expect(dialog).toBeVisible()
	await expect(dialog).toContainText('Kiro')
	const unsupportedStatus = dialog.getByRole('status')
	await expect(unsupportedStatus).toHaveText('Communication settings are unavailable in this runtime.')
	await expect(dialog.getByRole('checkbox', { name: 'Allow Sıtkı to message Kiro', exact: true })).toBeDisabled()
	await page.screenshot({ path: join(artifacts, 'pal-settings-unsupported-20261005.png') })
	const readsBeforeUnsupportedRefresh = await page.evaluate(() => window.__palSettingsProof.reads.length)
	await dialog.getByRole('button', { name: 'Refresh communication', exact: true }).click()
	await page.waitForFunction((expected) => window.__palSettingsProof?.reads.length === expected, readsBeforeUnsupportedRefresh + 1)
	await expect(unsupportedStatus).toHaveText('Communication settings are unavailable in this runtime.')
	await expect(dialog.getByRole('checkbox', { name: 'Allow Sıtkı to message Kiro', exact: true })).toBeDisabled()
	await page.keyboard.press('Escape')
	await expect(dialog).toHaveCount(0)
	await expect(trigger).toBeFocused()

	// The ordinary sample conversation keeps the traditional Activity panel.
	await page.getByRole('list', { name: 'Recent conversations', exact: true })
		.getByRole('button', { name: 'Refine navigation', exact: true }).click()
	await expect(card).toHaveCount(0)
	await expect(page.getByRole('button', { name: /Tasks · 0\/2 completed/ })).toBeVisible()
	await page.getByRole('button', { name: /Tasks · 0\/2 completed/ }).click()
	await expect(page.locator('.jobs-panel[data-open="true"]')).toBeVisible()
	await expect(page.locator('.jobs-panel').getByRole('region', { name: 'Conversation tasks', exact: true })).toBeVisible()

	assert.deepEqual(faults, [])
	const calls = await page.evaluate(() => window.__palSettingsProof.reads)
	assert.ok(calls.length >= 5)
	assert.ok(calls.every((call) => call.palId === 'sample-pal-1'))
	await writeFile(join(artifacts, 'pal-settings-browser-proof-20261005.json'), JSON.stringify({
		passed: true,
		browserPreview: true,
		inMemoryPal: true,
		fakeCommunicationApi: true,
		modelRequests: 0,
		providerRequests: 0,
		computerCalls: 0,
		externalRequests: 'aborted',
		checks: ['settings icon remains inside the avatar heading at fluid 240px and 300px card widths', 'old full Communication row absent', 'accessible Pal settings dialog title and Communication description', 'keyboard tabs', 'Escape and close button restore exact trigger focus', 'failed refresh retains rows, hides private error details and disables edits until a successful refresh', 'unsupported runtime notice persists after refresh, peer rows remain and permission controls stay disabled', 'Pal transcript hides only its scrollbar while wheel and PageDown scroll the real overflow region and expose its last message', 'Pal task fixture stays in the card; summary focuses details without opening Activity or shifting the card column', 'hiding profile then activating Pal task summary reopens the card and focuses its task region', 'short viewport keeps long dependency details reachable through bounded card scrolling', 'ordinary sample conversation still opens Activity with the Conversation tasks region'],
		widths,
		palTranscriptScroll,
		communicationReads: calls,
		faults,
	}, null, 2) + '\n')
	await unlink(join(artifacts, 'pal-settings-browser-failure-20261005.png')).catch(() => {})
	console.log(JSON.stringify({ passed: true, widths: widths.map((item) => item.card.width), reads: calls.length }))
} catch (error) {
	if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'pal-settings-browser-failure-20261005.png') }).catch(() => {})
	console.error(JSON.stringify({ failed: true, message: error instanceof Error ? error.message : String(error) }))
	throw error
} finally {
	await browser.close()
}
