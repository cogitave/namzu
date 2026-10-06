/** Real Vite renderer, synthetic DesktopEvents, no native/model/guest actions.
 * Semantic content and actual disclosure/keyboard/layout checks; no reference pixel-parity claim.
 */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'

const repo = resolve(process.argv[2] ?? '.')
const require = createRequire(join(repo, 'packages/desktop/package.json'))
const { createServer } = await import(require.resolve('vite'))
const server = await createServer({ root: join(repo, 'packages/desktop'),
	configFile: join(repo, 'packages/desktop/vite.config.ts'),
	server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' })
await server.listen()
const origin = `http://127.0.0.1:${server.httpServer.address().port}/preview`
const artifacts = join(repo, 'research/desktop-autonomy-20261007/artifacts')
const { chromium, expect } = require('@playwright/test')
const browser = await chromium.launch({ headless: true, executablePath: chromium.executablePath(), args: ['--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark', reducedMotion: 'no-preference' })
const page = await context.newPage()
page.setDefaultTimeout(12_000)
const faults = []
page.on('pageerror', error => faults.push(error.message))
await context.route('**/*', route =>
	new URL(route.request().url()).origin === new URL(origin).origin ? route.continue() : route.abort(),
)
await mkdir(artifacts, { recursive: true })
const receipt = { passed: false, realRenderer: true, browserOnly: true, modelRequests: 0,
 computerActions: 0, nativeActions: 0, checks: [], screenshots: [],
 referenceEvidence: 'Pinned upstream source notes in ../README.md',
 limitations: ['Isolated event fixtures with 60 distinct historical turns; no provider prompt or native computer action.', 'Reference live DOM unavailable; no pixel-parity claim.'] }


await page.addInitScript(() => {
	let api
	let normalId = 'sample-thread-1'
	let palId
	let normalProject = 'sample-app'
	let palProject
	const listeners = new Set()
	const at = Date.UTC(2026, 9, 7, 15)
	// The displayed elapsed duration is derived from admitted fixture timestamps,
	// with a fixed wall clock. Animation outcomes use their own explicit timeline.
	Date.now = () => at + 48000
	const nativeAnimate = Element.prototype.animate
	Element.prototype.animate = function (...args) {
		const animation = nativeAnimate.apply(this, args)
		const proof = window.__transcriptMotionProof
		if (proof && this.closest('.normal-transcript')) {
			// Pause on creation so fixture/browser scheduling cannot consume a short
			// animation before its explicit frame assertion reaches the element.
			if ([120, 160].includes(Number(animation.effect.getTiming().duration))) animation.pause()
			proof.animationCalls.push({ entry: this.dataset.transcriptEntryKey ?? null,
				duration: animation.effect.getTiming().duration, className: this.className })
		}
		return animation
	}
	const historical = () => {
		const messages = Array.from({ length: 60 }, (_, index) => [
			{ role: 'user', text: `Read saved item ${index + 1}.` },
			{ role: 'assistant', text: `**Saved item ${index + 1}**\n\nThis settled answer has a [source](https://example.invalid/source).\n\n- Keep its parsed body.\n- Keep the reader's position.`, phase: 'final_answer', status: 'completed' }
		]).flat()
		return { revision: 1, messages, partial: false, tasks: [], turn: 60, turns: {},
			timeline: messages.map((_, index) => ({ kind: 'message', index, turn: Math.floor(index / 2) + 1 })),
			running: false, queued: [], queuedItems: [], permissions: [], activeToolIds: [], responding: false, reasoning: {}, tools: {} }
	}

	const workspace = {
		windowId: 'motion-window', sequence: 0, homeGroupId: 'motion-group',
		layout: { version: 1, revision: 0, windows: [{ id: 'motion-window', focusedGroupId: 'motion-group',
			root: { kind: 'group', id: 'motion-group', tabs: [], activeTabId: '' } }] },
	}
	Object.defineProperty(window, 'namzu', {
		configurable: true, get: () => api,
		set(value) {
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
				workspace.layout.revision++
				workspace.sequence++
				return structuredClone(workspace)
			}
			api.onEvent = listener => { listeners.add(listener); return () => listeners.delete(listener) }
			// The fixture uses an isolated workspace group. The existing preview
			// stores draft owners at project scope; map only these synthetic group
			// keys to that accepted owner, without changing conversation ownership.
			for (const name of ['draft', 'saveDraft', 'attachments', 'draftSettings', 'saveDraftSettings']) {
				api[name] = (owner, ...args) => base[name](owner.replace(/:workspace:.*$/, ''), ...args)
			}
			api.openConversation = async (projectId, sessionId) => {
				const history = await base.openConversation(projectId, sessionId)
				if (sessionId === normalId) { const thread = historical(); return { messages: thread.messages, partial: false, thread } }
				if (sessionId === 'sample-thread-3') {
					const { restoreHistoryWork } = await import('/src/shared/history-work.ts')
					const { emptyThread } = await import('/src/shared/projection.ts')
					const messages = [
						{ role: 'user', text: 'Save the checked note, then skip the optional step.' },
						{ role: 'assistant', text: 'The note is saved; the optional step was skipped.', phase: 'final_answer' },
						{ role: 'user', text: 'Check the deliberately failing command.' },
						{ role: 'assistant', text: 'The command failed; nothing else was changed.', phase: 'final_answer' },
						{ role: 'user', text: 'Read one more saved result.' },
						{ role: 'assistant', text: 'The prior run ended before this read finished.', phase: 'final_answer' },
					]
					const work = { v: 1, partial: true,
						messages: messages.map((_, index) => ({ index, messageId: `saved-${index}`, turnId: `saved-turn-${Math.floor(index / 2)}`, order: Math.floor(index / 2) * 10 + (index % 2 ? 8 : 2) })),
						turns: ['completed', 'failed', 'interrupted'].map((status, index) => ({ turnId: `saved-turn-${index}`, userMessageId: `saved-${index * 2}`, order: index * 10 + 1, status, reason: ['end_turn', 'error', 'interrupted'][index], durationMs: [4321, 2000, 1000][index] })),
						tools: [
							{ turnId: 'saved-turn-0', toolUseId: 'write', name: 'write', order: 3, status: 'completed', presentation: { kind: 'diff', path: 'note.txt', before: 'Previous exact text', after: 'Checked exact text' } },
							{ turnId: 'saved-turn-0', toolUseId: 'optional', name: 'optional', order: 4, status: 'skipped', presentation: { kind: 'generic', label: 'Optional step' } },
							{ turnId: 'saved-turn-1', toolUseId: 'check', name: 'bash', order: 13, status: 'failed', presentation: { kind: 'terminal', command: 'false', output: 'Recorded exit 1' } },
							{ turnId: 'saved-turn-2', toolUseId: 'read', name: 'read', order: 23, status: 'interrupted', detailUnavailable: true },
						],
					}
					const thread = restoreHistoryWork(emptyThread(), messages, work)
					return { messages, partial: false, thread }
				}
				return history
			}
			api.newConversation = async projectId => {
				const view = await base.newConversation(projectId)
				if ((await base.projects()).find(project => project.id === projectId)?.palId) {
					palId = view.id; palProject = projectId
				}
				return view
			}
			api.backgroundWorkStatuses = async () => ({})
			api.send = async () => { throw new Error('This proof never submits a provider prompt.') }
			api.startPalComputer = api.stopPalComputer = async () => { throw new Error('This proof never starts or stops a computer.') }
			let revision = 100
			window.__transcriptMotionProof = {
				at,
				apiErrors: [],
				animationCalls: [],
				animations: new WeakMap(), nextAnimation: 1,
				emit(events, pal = false) {
					const sessionId = pal ? palId : normalId
					const projectId = pal ? palProject : normalProject
					if (!sessionId || !projectId) throw new Error('Fixture conversation not created.')
					for (const event of events) for (const listener of listeners)
						listener({ ...event, sessionId: event.sessionId ?? sessionId, projectId: event.projectId ?? projectId, ...(event.kind === 'background-work-status' ? {} : { revision: ++revision }) })
				},
			}
			for (const [name, method] of Object.entries(api)) {
				if (typeof method !== 'function' || name === 'onEvent') continue
				api[name] = (...args) => {
					try {
						const value = method(...args)
						return value && typeof value.then === 'function' ? value.catch(error => {
							window.__transcriptMotionProof.apiErrors.push({ name, args, message: error.message })
							throw error
						}) : value
					} catch (error) {
						window.__transcriptMotionProof.apiErrors.push({ name, args, message: error.message })
						throw error
					}
				}
			}
		},
	})
})

async function emit(events, pal = false) {
 await page.evaluate(({ events, pal }) => window.__transcriptMotionProof.emit(events, pal), { events, pal })
}
const update = value => ({ kind: 'update', update: value })
const state = running => ({ kind: 'state', running, queued: [], queuedItems: [] })
async function settle() {
 await page.evaluate(async () => {
  for (const animation of document.getAnimations()) if (Number.isFinite(animation.effect?.getComputedTiming().endTime)) {
   animation.finish(); await animation.finished.catch(() => {})
  }
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
 })
}
async function screenshot(name) {
 const file = `desktop-reading-v2-${name}-20261007.png`
 await settle(); await page.screenshot({ path: join(artifacts, file) }); receipt.screenshots.push(file)
}
async function appearance(mode) {
 await page.getByRole('navigation', { name: 'Main navigation', exact: true }).getByRole('button', { name: 'Profile', exact: true }).click()
 await page.getByRole('menuitemradio', { name: mode, exact: true }).click()
 await expect(page.locator('html')).toHaveClass(mode === 'Dark' ? /dark/ : /^(?!.*\bdark\b).*$/)
}
try {
 await page.goto(origin)
 await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
 await page.locator('[data-project-group="sample-app"]').getByRole('button', { name: 'Refine navigation', exact: true }).click()
 const scroller = page.locator('.transcript').last()
 const latest = page.getByRole('button', { name: 'Jump to latest messages', exact: true })
 await expect(page.locator('.normal-transcript')).toContainText('Saved item 60')
 await settle()
 const initial = await scroller.evaluate(node => ({ top: node.scrollTop, bottom: node.scrollHeight - node.clientHeight }))
 assert.ok(Math.abs(initial.top - initial.bottom) < 2, 'An opened ordinary conversation follows latest.')
 await expect(latest).toHaveCount(0)
 await scroller.evaluate(node => { node.scrollTop = 720 })
 await expect(latest).toBeVisible()
 const reading = await scroller.evaluate(node => node.scrollTop)
 const at = await page.evaluate(() => window.__transcriptMotionProof.at)
 await emit([{ kind: 'prompt', prompt: 'Check a new result.', at }, state(true),
  update({ kind: 'agent_message_chunk', messageId: 'streamed', phase: 'final_answer', text: '**New streamed reply**\n\n' })])
 await settle()
 assert.ok(Math.abs((await scroller.evaluate(node => node.scrollTop)) - reading) < 2, 'New output preserves old reading position.')
 const cdp = await context.newCDPSession(page)
 await cdp.send('Profiler.enable')
 await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
 for (let index = 0; index < 4; index++) {
  await emit([update({ kind: 'agent_message_chunk', messageId: 'streamed', phase: 'final_answer', text: `Chunk ${index + 1}.\n\n` })])
  await settle()
 }
 const coverage = await cdp.send('Profiler.takePreciseCoverage')
 await cdp.send('Profiler.stopPreciseCoverage')
 await cdp.detach()
 receipt.markdownProcessor = coverage.result.flatMap(script => script.functions.filter(fn => fn.functionName === 'Markdown' || fn.functionName === 'createProcessor').map(fn => ({ url: script.url.replace(new URL(origin).origin, ''), name: fn.functionName, calls: fn.ranges[0].count })))
 assert.ok(receipt.markdownProcessor.some(item => item.name === 'createProcessor' && item.calls === 8), 'Development StrictMode parses each changed live body twice.')
 assert.equal(receipt.markdownProcessor.filter(item => item.name === 'createProcessor').reduce((sum, item) => sum + item.calls, 0), 8, 'Settled Markdown is not parsed again.')
 assert.ok(Math.abs((await scroller.evaluate(node => node.scrollTop)) - reading) < 2)
 await screenshot('reading-dark')
 receipt.checks.push('120 historical messages: streaming preserves reader position; V8 coverage records eight Markdown processor calls for four changed live bodies in development StrictMode (two calls per changed body, zero settled reparses).')
 await latest.focus()
 await page.keyboard.press('Enter')
 await expect(latest).toHaveCount(0)
 await settle()
 const afterJump = await scroller.evaluate(node => ({ top: node.scrollTop, bottom: node.scrollHeight - node.clientHeight }))
 assert.ok(Math.abs(afterJump.top - afterJump.bottom) < 2)
 await scroller.evaluate(node => {
  node.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true }))
  node.dispatchEvent(new Event('touchstart', { bubbles: true }))
 })
 await emit([update({ kind: 'agent_message_chunk', messageId: 'streamed', phase: 'final_answer', text: 'A further paragraph follows after jumping back.\n\n' })])
 await settle()
 const followed = await scroller.evaluate(node => ({ top: node.scrollTop, bottom: node.scrollHeight - node.clientHeight }))
 assert.ok(Math.abs(followed.top - followed.bottom) < 2)
 receipt.checks.push('Keyboard jump resumes streaming follow; downward wheel at the bottom and a touch without scrolling do not stop following.')
 await scroller.evaluate(node => { node.scrollTop = 980 })
 await expect(latest).toBeVisible()
 const savedPosition = await scroller.evaluate(node => node.scrollTop)
 await page.locator('[data-project-group="sample-app"]').getByRole('button', { name: 'Polish empty states', exact: true }).click()
 await expect(page.locator('.normal-transcript')).toContainText('Sample conversation')
 await page.getByRole('tab', { name: /Refine navigation/ }).click()
 await expect(page.locator('.normal-transcript')).toContainText('Chunk 4')
 await settle()
 assert.ok(Math.abs((await scroller.evaluate(node => node.scrollTop)) - savedPosition) < 2, 'Warm navigation restores reading position.')
 await expect(latest).toBeVisible()
 receipt.checks.push('Warm A → B → A navigation restores the reader position without losing streamed messages.')
 await emit([update({ kind: 'turn_ended', stopReason: 'end_turn', reason: 'stop_condition' }), state(false)])
 const fixtureNow = at + 48000
 const background = status => ({ kind: 'background-work-status', sessionId: 'sample-thread-2', projectId: 'sample-app', status })
 const otherTab = page.getByRole('tab', { name: /Polish empty states/ })
 await emit([background({ state: 'known', runningCount: 2, needsAttention: false, checkedAt: fixtureNow, expiresAt: fixtureNow + 15000 })])
 await expect(otherTab.locator('[data-background-work="running"]')).toHaveText('2')
 await expect(otherTab).toHaveAttribute('aria-description', '2 processes running in background')
 await expect(page.locator('.sidebar [data-background-work="running"]')).toHaveCount(2)
 await expect(page.locator('.normal-transcript > .working[aria-hidden="false"]')).toHaveCount(0)
 await screenshot('background-other-tab')
 await emit([background({ state: 'known', runningCount: 0, needsAttention: true, checkedAt: fixtureNow, expiresAt: fixtureNow + 15000 })])
 await expect(otherTab.locator('[data-background-work="attention"]')).toHaveText('!')
 await expect(otherTab).toHaveAttribute('aria-description', 'Background work needs attention')
 await emit([background({ state: 'unknown' })])
 await expect(otherTab.locator('[data-background-work]')).toHaveCount(0)
 await emit([background({ state: 'known', runningCount: 8, needsAttention: false, checkedAt: fixtureNow - 30000, expiresAt: fixtureNow - 15000 })])
 await expect(otherTab.locator('[data-background-work]')).toHaveCount(0)
 await emit([background({ state: 'unavailable' })])
 await expect(otherTab.locator('[data-background-work]')).toHaveCount(0)
 await expect(latest).toBeVisible()
 assert.ok(Math.abs((await scroller.evaluate(node => node.scrollTop)) - savedPosition) < 2)
 receipt.checks.push('Inactive ordinary tab and sidebar show exact running count and terminal attention; unknown, expired and unavailable snapshots show no stale badge or live transcript status.')

 await page.locator('[data-project-group="sample-app"]').getByRole('button', { name: 'Review message settings', exact: true }).click()
 await expect(page.locator('.normal-transcript')).toContainText('The note is saved')
 await expect(page.locator('.normal-transcript').getByText('Some saved work details are unavailable.', { exact: true })).toBeVisible()
 const savedWork = page.getByRole('button', { name: 'Worked for 4s', exact: true })
 await expect(savedWork).toHaveAttribute('data-duration-source', 'recorded-runtime')
 await expect(savedWork).toHaveAttribute('title', 'Time reported for this saved work')
 await savedWork.click()
 await page.getByRole('button', { name: 'Edited note.txt Completed', exact: true }).click()
 await expect(page.locator('.diff')).toContainText('Previous exact text')
 await expect(page.locator('.diff')).toContainText('Checked exact text')
 await expect(page.locator('[data-tool-state="skipped"]')).toContainText('Skipped')
 await page.getByRole('button', { name: 'Work incomplete · 2s', exact: true }).click()
 await page.getByRole('button', { name: 'Command failed: false Failed', exact: true }).click()
 await expect(page.locator('[data-tool-state="failed"] .tool-content')).toContainText('Recorded exit 1')
 await page.getByRole('button', { name: 'Work incomplete · 1s', exact: true }).click()
 await expect(page.locator('[data-tool-state="interrupted"]')).toContainText('Interrupted')
 await expect(page.locator('.normal-transcript > .working[aria-hidden="false"], .permission-card')).toHaveCount(0)
 const restored = await page.evaluate(async () => (await window.namzu.openConversation('sample-app', 'sample-thread-3')).thread)
 assert.equal(restored.running, false)
 assert.deepEqual(restored.permissions, [])
 assert.deepEqual(restored.activeToolIds, [])
 assert.equal(restored.retry, undefined)
 assert.equal(restored.historyWorkPartial, true)
 assert.equal(restored.messages.length, 6)
 await screenshot('saved-work-dark')
 receipt.checks.push('Actual rich-history projection restores saved runtime duration, exact diff, skipped, failed and interrupted receipts; incomplete work detail is separate from complete text, with no live phase, approval or retry authority.')
 await page.getByRole('tab', { name: /Refine navigation/ }).click()
 await expect(page.locator('.normal-transcript')).toContainText('Chunk 4')
 await settle()
 assert.ok(Math.abs((await scroller.evaluate(node => node.scrollTop)) - savedPosition) < 2)

 await appearance('Light')
 await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
 await page.setViewportSize({ width: 720, height: 620 })
 await settle()
 await scroller.evaluate(node => { node.scrollTop = 650 })
 await expect(latest).toBeVisible()
 receipt.narrow = await latest.evaluate(button => {
  const bounds = button.getBoundingClientRect(), lane = button.closest('.conversation-lane').getBoundingClientRect()
  return { button: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, lane: { x: lane.x, y: lane.y, width: lane.width, height: lane.height }, overflow: document.documentElement.scrollWidth > innerWidth, animations: button.getAnimations().filter(a => Number.isFinite(a.effect?.getComputedTiming().endTime)).length }
 })
 assert.equal(receipt.narrow.overflow, false)
 assert.equal(receipt.narrow.animations, 0)
 assert.ok(receipt.narrow.button.y >= receipt.narrow.lane.y && receipt.narrow.button.y + receipt.narrow.button.height <= receipt.narrow.lane.y + receipt.narrow.lane.height)
 await screenshot('light-narrow-reduced')
 await latest.click()
 await settle()
 await expect(latest).toHaveCount(0)
 receipt.checks.push('Narrow, short light viewport keeps the control inside its lane; reduced motion jumps instantly with no entrance animation.')
 await appearance('Dark')
 await page.setViewportSize({ width: 1280, height: 900 })
 await page.getByRole('button', { name: 'Create your first Pal', exact: true }).click()
 await page.locator('.pal-welcome').getByRole('button', { name: 'Customize your Pal', exact: true }).click()
 const customize = page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
 await customize.getByRole('textbox', { name: 'Pal name', exact: true }).fill('Reading Pal')
 await customize.getByRole('button', { name: 'Save', exact: true }).click()
 await expect(customize).toHaveCount(0)
 const palScroller = page.locator('.transcript').last()
 await emit(Array.from({ length: 30 }, (_, index) => [
  { kind: 'prompt', prompt: `Tell me about saved item ${index + 1}.`, at: at + index * 1000 },
  state(true), update({ kind: 'agent_message', messageId: `delivered-${index}`, status: 'completed', content: `Here is the checked result for item ${index + 1}.\n\nA friend-style delivered reply, separate from work details.`, stopReason: 'end_turn' }),
  update({ kind: 'turn_ended', stopReason: 'end_turn', reason: 'stop_condition' }), state(false)
 ]).flat(), true)
 await settle()
 await palScroller.evaluate(node => { node.scrollTop = 600 })
 await expect(latest).toBeVisible()
 const palReading = await palScroller.evaluate(node => node.scrollTop)
 await emit([{ kind: 'prompt', prompt: 'One more checked result.', at: at + 35000 }, state(true), update({ kind: 'agent_message', messageId: 'pal-final', status: 'completed', content: 'I checked one more result.', stopReason: 'end_turn' }), update({ kind: 'turn_ended', stopReason: 'end_turn', reason: 'stop_condition' }), state(false)], true)
 await settle()
 assert.ok(Math.abs((await palScroller.evaluate(node => node.scrollTop)) - palReading) < 2)
 assert.equal(await palScroller.evaluate(node => getComputedStyle(node).scrollbarWidth), 'none')
 await expect(page.locator('.normal-transcript, .turn-activity, .jobs-panel')).toHaveCount(0)
 await screenshot('pal-reading')
 await latest.click()
 await settle()
 await expect(latest).toHaveCount(0)
 receipt.checks.push('Pal keeps friend-style bubbles and hidden scrollbar; new delivered replies preserve reading position and the latest control works without coding panels.')
 assert.deepEqual(faults, [])
 receipt.apiErrors = await page.evaluate(() => window.__transcriptMotionProof.apiErrors)
 assert.deepEqual(receipt.apiErrors, [])
 receipt.passed = true
} catch (error) {
 receipt.error = { name: error.name, message: error.message }
 process.exitCode = 1
 await page.screenshot({ path: join(artifacts, 'desktop-reading-failure.png') }).catch(() => {})
} finally {
 receipt.rendererErrors = faults
 await browser.close()
 await server.close()
 await writeFile(join(artifacts, 'desktop-reading-browser-proof.json'), `${JSON.stringify(receipt, null, 2)}\n`)
 process.stdout.write(`${JSON.stringify({ passed: receipt.passed, checks: receipt.checks, markdownProcessor: receipt.markdownProcessor, error: receipt.error })}\n`)
}
