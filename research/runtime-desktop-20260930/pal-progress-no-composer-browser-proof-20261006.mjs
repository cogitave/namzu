/** Synthetic browser check for Pal progress in the card only, plus ordinary Activity.
 * Uses the existing design-preview fixture pattern. No live runtime or model calls.
 * Run against an owned Vite design preview with NAMZU_DESKTOP_DEV_URL set.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
assert.ok(args.includes('--no-composer-summary'), 'run this proof with --no-composer-summary')
const repo = resolve(args.find((arg) => !arg.startsWith('--')) ?? '.')
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
				['diff-output', 'edit_file', 'completed', 'Completed file changes', { kind: 'diff', path: 'proof.txt', before: 'old fixture', after: 'new fixture' }],
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
					} else if (action.kind === 'close') {
						group.tabs = group.tabs.filter((tabId) => tabId !== action.tabId)
						if (group.activeTabId === action.tabId)
							group.activeTabId = group.tabs.at(-1) ?? ''
						workspace.layout.revision++
						workspace.sequence++
					}
					return structuredClone(workspace)
				}
				api.onEvent = (listener) => { listeners.add(listener); return () => listeners.delete(listener) }
				const newConversation = api.newConversation.bind(api)
				api.newConversation = async (projectId) => {
					const result = await newConversation(projectId)
					const owner = (await api.projects()).find((project) => project.id === projectId)
					if (owner?.palId) {
						window.__palProgressProof.sessionId = result.id
						if (window.__palProgressProof.seedJobsOpenOnPal) {
							localStorage.setItem(`namzu.workspace.presentation:${result.id}`, JSON.stringify({
								computerChat: 'floating', floatingChatMinimized: false, palProfileOpen: false,
								computerProfileOpen: false, jobsOpen: true, panelTab: 'changes', follow: true,
								scrollTop: 0,
							}))
						}
					} else {
						window.__palProgressProof.normalSessionId = result.id
						window.__palProgressProof.normalProjectId = projectId
					}
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
					seedJobsOpenOnPal: sessionStorage.getItem('pal-card-only-seed-jobs-open') === '1',
					injectNormalMessage(sessionId, projectId) {
						for (const listener of listeners) {
							listener({ kind: 'prompt', sessionId, prompt: 'Fixture request' })
							listener({ kind: 'update', projectId, sessionId, update: {
								kind: 'agent_message', status: 'completed', messageId: 'fixture-answer', content: 'Fixture answer',
							} })
						}
					},
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
	const assertCardProgress = async () => {
		await expect(page.locator('.tasks-progress')).toHaveCount(0)
		await expect(tasks).toHaveCount(1)
		await expect(tasks.getByRole('heading', { name: 'Progress', exact: true })).toBeVisible()
	}
	await assertCardProgress()
	const toggle = tasks.getByRole('button', { name: 'View plan steps', exact: true })
	await expect(toggle).toHaveAttribute('aria-expanded', 'false')
	await toggle.focus()
	await page.keyboard.press('Enter')
	await expect(toggle).toHaveAttribute('aria-expanded', 'true')
	await expect(tasks.locator('.pal-plan-steps li')).toHaveCount(3)
	const measurements = []
	for (const [width, height] of [[1188, 900], [1024, 420]]) {
		await page.setViewportSize({ width, height })
		await assertCardProgress()
		await settleCardMotion(card)
		measurements.push(await page.evaluate(() => {
			const box = (e) => { const b=e.getBoundingClientRect(); return { x:b.x,y:b.y,width:b.width,height:b.height } }
			const card=document.querySelector('.pal-context-card')
			const composer=document.querySelector('.pal-composer-shell')
			return { viewport:{ width:innerWidth,height:innerHeight }, card:box(card), composer:box(composer), transcriptSummaries:document.querySelectorAll('.tasks-progress').length, cardPlans:card.querySelectorAll('.conversation-tasks').length }
		}))
	}
	await page.setViewportSize({ width:1188,height:900 })
	await page.screenshot({ path:join(artifacts,'pal-progress-no-composer-completed-20261006.png') })
	await page.evaluate(() => window.__palProgressProof.setMode('mixed'))
	await assertCardProgress()
	await expect(tasks).toContainText('In progress')
	await expect(tasks).toContainText('Waiting on: Verify proof note')
	await expect(tasks).toContainText('Needs attention')
	await page.evaluate(() => window.__palProgressProof.setMode('failed'))
	await assertCardProgress()
	await expect(tasks).toContainText('Needs attention')
	await page.evaluate(() => window.__palProgressProof.setMode('unavailable'))
	await assertCardProgress()
	await expect(tasks).toContainText('Task list unavailable')
	await page.getByRole('button',{ name:'Home',exact:true }).click()
	await page.getByRole('list',{ name:'Sample app conversations',exact:true }).getByRole('button',{ name:'Sample draft',exact:true }).click()
	await expect(page.getByRole('tab',{ name:'Namzu: Sample draft',exact:true })).toHaveAttribute('aria-selected','true')
	const normalSessionId=await page.evaluate(async()=>{
		const workspace=await window.namzu.workspace()
		const sessionId=workspace.layout.windows[0].root.activeTabId
		for(const listener of window.__palProgressProof.listeners) listener({kind:'tasks',sessionId,tasks:[
			{taskId:'ordinary-write',subject:'Write proof note',status:'completed',blockedBy:[]},
			{taskId:'ordinary-verify',subject:'Verify proof note',status:'completed',blockedBy:[]},
			{taskId:'ordinary-wait',subject:'Await missing companion',status:'completed',blockedBy:[]}
		]})
		return sessionId
	})
	assert.ok(normalSessionId)
	const summary=page.locator('.tasks-progress')
	await expect(summary).toHaveCount(1)
	await expect(summary).toContainText('Tasks · 3/3 completed')
	await summary.click()
	await expect(page.locator('.jobs-panel[data-open="true"]')).toBeVisible()
	await expect(page.locator('.jobs-panel .conversation-tasks')).toContainText('Write proof note')
	await page.screenshot({ path:join(artifacts,'pal-progress-no-composer-ordinary-20261006.png') })
	assert.deepEqual(faults,[])
	await writeFile(join(artifacts,'pal-progress-no-composer-browser-20261006.json'),JSON.stringify({ version:1,passed:true,verifiedAt:new Date().toISOString(),scope:'Synthetic Vite preview only; no live runtime state',modelRequests:0,providerRequests:0,computerCalls:0,externalRequests:'aborted',checks:['Pal transcript has no duplicate task progress in completed, mixed, failed and unavailable states','Pal card retains named Progress region and keyboard disclosure','Wide and short viewport retain a single card plan','Ordinary task summary opens Activity and retains its real fixture plan'],measurements,faults },null,2)+'\n')
	console.log(JSON.stringify({ passed:true,checks:4,measurements }))
} catch(error) {
	await page.screenshot({path:join(artifacts,'pal-progress-no-composer-failure-20261006.png')}).catch(()=>{})
	throw error
} finally {
	await browser.close()
}
