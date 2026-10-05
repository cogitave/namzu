/** Browser-only proof for Pal planning progress and safe recent activity.
 * Uses the Vite design preview and injected in-memory tasks/tool receipts.
 * No native application, model, provider, computer or live runtime calls.
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
const context = await browser.newContext({ viewport: { width: 1188, height: 900 }, colorScheme: 'dark' })
const page = await context.newPage()
page.setDefaultTimeout(10_000)
const faults = []
page.on('pageerror', (error) => faults.push(error.message))
await context.route('**/*', (route) =>
	new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort(),
)
await mkdir(artifacts, { recursive: true })
async function settleCardMotion(card) {
	await card.evaluate(async (element) => {
		const running = element.getAnimations({ subtree: true }).filter((animation) => {
			const endTime = animation.effect?.getComputedTiming().endTime
			return animation.playState === 'running' && typeof endTime === 'number' && Number.isFinite(endTime)
		})
		await Promise.all(running.map((animation) => animation.finished.catch(() => {})))
		await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	})
}

try {
	await page.addInitScript(() => {
		let api
		const listeners = new Set()
		let mode = 'completed'
		const threadFor = () => {
			const completed = [
				{ taskId: 'step-write', subject: 'Write proof note', status: 'completed', blockedBy: [] },
				{ taskId: 'step-verify', subject: 'Verify proof note', status: 'completed', blockedBy: [] },
				{ taskId: 'step-wait', subject: 'Await missing companion', status: 'completed', blockedBy: [] },
			]
			const mixed = [
				{ taskId: 'step-write', subject: 'Write proof note', status: 'completed', blockedBy: [] },
				{ taskId: 'step-verify', subject: 'Verify proof note', status: 'in_progress', blockedBy: [] },
				{ taskId: 'step-wait', subject: 'Await missing companion', status: 'pending', blockedBy: ['step-verify'] },
				{ taskId: 'step-recover', subject: 'Continue after failed prerequisite', status: 'pending', blockedBy: ['step-failed'] },
				{ taskId: 'step-failed', subject: 'Inspect failed prerequisite', status: 'failed', blockedBy: [] },
			]
			const failed = [
				{ taskId: 'step-write', subject: 'Write proof note', status: 'failed', blockedBy: [] },
				{ taskId: 'step-verify', subject: 'Verify proof note', status: 'pending', blockedBy: ['step-write'] },
			]
			const long = [
				{ taskId: 'step-prereq', subject: 'Prepare the unusually long prerequisite title that must wrap cleanly inside the narrow Pal context panel', status: 'failed', blockedBy: [] },
				{ taskId: 'step-long', subject: 'Continue with a very long dependent task title and keep its state badge aligned at the far right edge', status: 'pending', blockedBy: ['step-prereq'] },
			]
			const tasks = mode === 'mixed' ? mixed : mode === 'failed' ? failed : mode === 'long' ? long : completed
			const toolRows = [
				['plan-create', 'task_create', 'completed', 'Plan step created', { kind: 'generic', label: 'PRIVATE task args: step-write' }],
				['msg-send', 'send_pal_message', 'completed', 'Accepted · awaiting delivery', { kind: 'generic', label: 'PRIVATE receipt body: secret text' }],
				['pals-list', 'list_pals', 'completed', 'Kiro · private peer list', { kind: 'generic', label: 'PRIVATE peer list' }],
				['custom-tool', 'mcp_secret_action', 'completed', 'PRIVATE tool args: token=abc', { kind: 'generic', label: 'PRIVATE tool args: token=abc' }],
				['plan-update-failed', 'task_update', 'failed', 'Plan update failed', { kind: 'terminal', command: 'PRIVATE task update', output: 'PRIVATE failure details' }],
			]
			const tools = Object.fromEntries(toolRows.map(([id, title, status, _receipt, view]) => [
				`1:${id}`,
				{ kind: 'tool_call', toolCallId: id, title, status, view },
			]))
			const timeline = [
				{ kind: 'message', index: 0, turn: 1 },
				...toolRows.map(([id]) => ({ kind: 'tool', id: `1:${id}`, turn: 1 })),
			]
			return {
				tasks,
				messages: [{ role: 'user', text: 'Fixture request' }], timeline, turn: 1, turns: {},
				running: false, queued: [], queuedItems: [], activeToolIds: [], permissions: [],
				tools, reasoning: {}, responding: false,
			}
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
						window.__palProgressProof.sessionId = result.id
					return result
				}
				const openConversation = api.openConversation.bind(api)
				api.openConversation = async (projectId, sessionId) => {
					const history = await openConversation(projectId, sessionId)
					if (window.__palProgressProof.sessionId !== sessionId) return { ...history, thread: threadFor() }
					const thread = threadFor()
					return { ...history, messages: thread.messages, thread }
				}
				api.refreshTasks = async (sessionId) => {
					for (const listener of listeners)
						listener({ kind: 'tasks', sessionId, tasks: structuredClone(threadFor().tasks) })
				}
				window.__palProgressProof = {
					mode,
					listeners,
					setMode(next) {
						mode = next
						this.mode = next
						for (const listener of listeners) listener(next === 'unavailable'
							? { kind: 'tasks', sessionId: this.sessionId, notice: 'Task list unavailable.' }
							: { kind: 'tasks', sessionId: this.sessionId, tasks: structuredClone(threadFor().tasks) })
					},
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
	const tasks = card.getByRole('region', { name: 'Sıtkı tasks', exact: true })
	await expect(tasks.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
	const doneToggle = tasks.locator('.pal-plan-toggle')
	await expect(doneToggle).toContainText('3 of 3 steps')
	await expect(doneToggle).toHaveAttribute('aria-description', '3 of 3 steps done')
	await expect(doneToggle).toHaveAttribute('aria-expanded', 'false')
	const count = doneToggle.locator('.pal-plan-count')
	await expect(count).toHaveText('3 of 3 steps')
	await expect(count).toHaveAttribute('title', '3 of 3 steps done')
	await expect(count.locator('kbd')).toHaveCount(0)
	const counterStyle = await count.evaluate((element) => ({
		background: getComputedStyle(element).backgroundColor,
		borderRadius: getComputedStyle(element).borderRadius,
		padding: getComputedStyle(element).padding,
	}))
	assert.notEqual(counterStyle.background, 'rgba(0, 0, 0, 0)', 'step count should read as a capsule')
	assert.ok(parseFloat(counterStyle.borderRadius) >= 5, 'step count should have rounded capsule corners')
	await expect(tasks).not.toContainText('Write proof note')
	await tasks.screenshot({ path: join(artifacts, 'pal-progress-compact-collapsed-20261006.png') })
	await doneToggle.focus()
	await page.keyboard.press('Enter')
	await expect(doneToggle).toHaveAttribute('aria-expanded', 'true')
	await expect(tasks.locator('.pal-plan-steps')).toBeVisible()
	await expect(tasks).toContainText('Write proof note')
	await expect(tasks).toContainText('Await missing companion')
	await expect(tasks.locator('.pal-step-row')).toHaveCount(3)
	await expect(tasks.locator('.pal-step-state')).toHaveCount(3)
	await expect(tasks.locator('.pal-step-state')).toContainText(['Done', 'Done', 'Done'])
	const completedMetrics = await tasks.locator('.pal-plan-steps li').evaluateAll((rows) => rows.map((row) => {
		const rect = row.getBoundingClientRect()
		const subject = row.querySelector('.pal-step-subject').getBoundingClientRect()
		const badge = row.querySelector('.pal-step-state').getBoundingClientRect()
		return { height: rect.height, subjectRight: subject.right, badgeLeft: badge.left, badgeRight: badge.right, rowRight: rect.right }
	}))
	assert.ok(completedMetrics.every((row) => row.height <= 36), `short completed row should be compact: ${JSON.stringify(completedMetrics)}`)
	assert.ok(completedMetrics.every((row) => row.badgeLeft >= row.subjectRight - 0.5 && row.badgeRight <= row.rowRight + 0.5), 'Done badge should sit to the right of its subject within the row')
	await expect(tasks.locator('progress')).toHaveCount(0)
	await settleCardMotion(card)
	await tasks.screenshot({ path: join(artifacts, 'pal-progress-compact-completed-20261006.png') })

	await page.evaluate(() => window.__palProgressProof.setMode('mixed'))
	await expect(tasks).toContainText('Verify proof note')
	await expect(tasks).toContainText('In progress')
	await expect(tasks).toContainText('Waiting')
	await expect(tasks).toContainText('Needs attention')
	await expect(tasks).toContainText('Continue after failed prerequisite')
	const failureColor = await tasks.locator('.pal-plan-steps li[data-status="failed"] .task-state').evaluate((label) => {
		const actual = getComputedStyle(label).color
		const expected = document.createElement('span')
		expected.style.color = 'var(--error-foreground)'
		label.append(expected)
		const expectedColor = getComputedStyle(expected).color
		expected.remove()
		return { actual, expected: expectedColor }
	})
	assert.equal(failureColor.actual, failureColor.expected, 'failed step label should use the theme error foreground')
	const recoverRow = tasks.locator('.pal-plan-steps li').filter({ hasText: 'Continue after failed prerequisite' })
	await expect(recoverRow).not.toContainText('Waiting')
	await expect(tasks.locator('progress')).toHaveCount(0)
	await tasks.screenshot({ path: join(artifacts, 'pal-progress-compact-mixed-20261006.png') })
	await page.evaluate(() => window.__palProgressProof.setMode('long'))
	await expect(tasks).toContainText('Earlier step: Prepare the unusually long prerequisite title')
	const longLayout = await tasks.locator('.pal-plan-steps li').evaluateAll((rows) => rows.map((rowElement) => {
		const box = (node) => { const { left, right, top, bottom } = node.getBoundingClientRect(); return { left, right, top, bottom } }
		const row = box(rowElement)
		const subject = box(rowElement.querySelector('.pal-step-subject'))
		const badge = box(rowElement.querySelector('.pal-step-state'))
		const dependency = rowElement.querySelector('.pal-step-copy p')
		return { row, subject, badge, dependency: dependency ? box(dependency) : null }
	}))
	assert.ok(longLayout.every(({ row, subject, badge }) => badge.left >= subject.left && badge.right <= row.right + 0.5), 'long titles should not push state badges beyond row content')
	assert.ok(longLayout.every(({ subject, badge }) => Math.min(subject.right, badge.right) <= Math.max(subject.left, badge.left) || subject.bottom <= badge.top + 0.5), 'long title and state badge should not overlap')
	assert.ok(longLayout[1].dependency && longLayout[1].dependency.top >= longLayout[1].badge.bottom - 0.5, 'dependency paragraph should follow the subject row')
	await tasks.screenshot({ path: join(artifacts, 'pal-progress-compact-long-content-20261006.png') })
	const compactWidths = []
	for (const [width, height] of [[1024, 900], [1188, 900], [1188, 420]]) {
		await page.setViewportSize({ width, height })
		const measured = await tasks.evaluate((element) => ({
			width: element.getBoundingClientRect().width,
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			steps: [...element.querySelectorAll('.pal-plan-steps li')].map((row) => {
				const rowRect = row.getBoundingClientRect()
				const badgeRect = row.querySelector('.pal-step-state').getBoundingClientRect()
				return { rowRight: rowRect.right, badgeRight: badgeRect.right }
			}),
		}))
		assert.ok(measured.scrollWidth <= measured.clientWidth, `long content should not overflow at viewport width ${width}`)
		assert.ok(measured.steps.every((step) => step.badgeRight <= step.rowRight + 0.5), `state badges should remain inside rows at viewport width ${width}`)
		compactWidths.push({ viewport: { width, height }, ...measured })
	}
	await page.setViewportSize({ width: 1188, height: 900 })
	const composerSummary = await page.locator('.tasks-progress[data-pal-progress="true"]').evaluate((button) => {
		const bounds = (node) => {
			const rect = node.getBoundingClientRect()
			return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
		}
		const outer = bounds(button)
		const children = [...button.children].map(bounds)
		const overlaps = []
		for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
			const a = children[i], b = children[j]
			if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5)
				overlaps.push([i, j])
		}
		return {
			text: button.textContent,
			outer,
			children,
			overlaps,
			escaped: children.some((child) => child.left < outer.left - 0.5 || child.right > outer.right + 0.5 || child.top < outer.top - 0.5 || child.bottom > outer.bottom + 0.5),
		}
	})
	assert.match(composerSummary.text, /^Progress/)
	assert.deepEqual(composerSummary.overlaps, [], 'mixed composer summary children should not overlap')
	assert.equal(composerSummary.escaped, false, 'mixed composer summary children should fit inside the summary control')

	await page.evaluate(() => window.__palProgressProof.setMode('failed'))
	await expect(tasks).toContainText('Needs attention')
	await expect(tasks).toContainText('Earlier step: Write proof note (needs attention)')
	await expect(tasks).not.toContainText('Waiting')
	await tasks.screenshot({ path: join(artifacts, 'pal-progress-compact-failed-20261006.png') })
	await page.evaluate(() => window.__palProgressProof.setMode('unavailable'))
	await expect(tasks).toContainText('Task list unavailable')

	const activity = card.getByRole('region', { name: 'Recent activity', exact: true })
	await expect(activity).toContainText('Message to another Pal')
	await expect(activity).toContainText('Sent to inbox')
	await expect(activity).toContainText('Available Pals')
	await expect(activity).toContainText('Checked')
	await expect(activity).toContainText('Other action')
	await expect(activity).toContainText('Update the plan')
	await expect(activity).toContainText('Couldn’t finish')
	for (const privateText of ['send_pal_message', 'list_pals', 'mcp_secret_action', 'task_update', 'PRIVATE', 'Kiro'])
		await expect(activity).not.toContainText(privateText)
	await expect(activity).not.toContainText('task_create')
	await activity.screenshot({ path: join(artifacts, 'pal-progress-compact-activity-20261006.png') })
	const geometry = []
	for (const [width, height] of [[1188, 900], [1024, 900], [1188, 420]]) {
		await page.setViewportSize({ width, height })
		await expect(card).toBeVisible()
		const measured = await card.evaluate((element) => ({
			width: element.getBoundingClientRect().width,
			height: element.getBoundingClientRect().height,
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
			scrollHeight: element.scrollHeight,
			clientHeight: element.clientHeight,
			documentWidth: document.documentElement.scrollWidth,
			viewportWidth: innerWidth,
		}))
		assert.ok(measured.scrollWidth <= measured.clientWidth, `Pal card horizontal overflow at ${width}px`)
		assert.ok(measured.documentWidth <= measured.viewportWidth, `page horizontal overflow at ${width}px`)
		if (height < 500)
			assert.ok(measured.clientHeight < measured.scrollHeight, 'short viewport should keep the card bounded with internal scrolling')
		geometry.push({ viewport: { width, height }, ...measured })
		if (height < 500) await tasks.screenshot({ path: join(artifacts, 'pal-progress-compact-short-viewport-20261006.png') })
	}
	await page.setViewportSize({ width: 1188, height: 900 })
	await activity.getByRole('button', { name: /Message to another Pal/ }).click()
	await expect(page.locator('.jobs-panel[data-open="true"]')).toBeVisible()
	const detailed = page.getByRole('region', { name: 'Pal actions', exact: true })
	await detailed.getByRole('button', { name: 'send_pal_message Completed', exact: true }).click()
	await expect(detailed).toContainText('PRIVATE receipt body: secret text')
	await expect(detailed).toContainText('send_pal_message')
	await page.evaluate(() => window.__palProgressProof.setMode('mixed'))
	await expect(tasks).toContainText('In progress')
	await page.emulateMedia({ reducedMotion: 'reduce' })
	const reducedMotion = await card.evaluate((element) => ({
	prefersReduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
	spinnerAnimation: getComputedStyle(element.querySelector('.pal-context-loading')).animationName,
	}))
	assert.equal(reducedMotion.prefersReduced, true)
	assert.equal(reducedMotion.spinnerAnimation, 'none')
	assert.deepEqual(faults, [])
	await writeFile(join(artifacts, 'pal-progress-compact-browser-proof-20261006.json'), JSON.stringify({
		passed: true,
		browserPreview: true,
		inMemoryTasksAndToolReceipts: true,
		modelRequests: 0,
		providerRequests: 0,
		computerCalls: 0,
		externalRequests: 'aborted',
		checks: [
			'Pal step counter shows a compact “<done> of <total> steps” capsule with the full count in its title and no kbd element',
			'completed state is a Done badge at the right of the subject row; short rows fit within 36px',
			'long subjects wrap without pushing badges outside row content; dependency text sits below the subject row',
			'long content fits at 240px and 300px card widths and in a short viewport',
			'Pal task region is named for the Pal and headed Progress',
			'all-completed plan is collapsed by default and keyboard Enter opens the actual subjects',
			'mixed tasks remain visible with active, blocked and failed states; failed prerequisite is terminal for dependency display',
			'failed and unavailable task states stay visible',
			'no percentage progress indicator is rendered',
			'card activity uses safe known intent labels and status; hides successful planning bookkeeping and all raw tool names/arguments/receipts',
			'clicking card activity opens the detailed Pal actions receipts unchanged',
			'layout has no horizontal overflow at 240px, 300px and short height viewports',
		],
		geometry,
		completedMetrics,
		longLayout,
		compactWidths,
		counterStyle,
		failureColor,
		composerSummary,
		reducedMotion,
		fixtureVsReal: 'All tasks and receipts are synthetic preview fixtures; no runtime/provider was used.',
		faults,
	}, null, 2) + '\n')
	await unlink(join(artifacts, 'pal-progress-compact-browser-failure-20261006.png')).catch(() => {})
	console.log(JSON.stringify({ passed: true, compactWidths: compactWidths.map(({ viewport }) => viewport), completedRows: completedMetrics.map(({ height }) => height) }))
} catch (error) {
	if (!page.isClosed()) await page.screenshot({ path: join(artifacts, 'pal-progress-compact-browser-failure-20261006.png') }).catch(() => {})
	console.error(JSON.stringify({ failed: true, message: error instanceof Error ? error.message : String(error) }))
	throw error
} finally {
	await browser.close()
}
