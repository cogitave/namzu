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
const artifacts = join(repo, 'research/runtime-desktop-20260930/artifacts')
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
 referenceEvidence: 'transcript-reference-observations-20261006.json',
 limitations: ['Isolated event fixtures; no provider prompt or native computer action.', 'Reference live DOM unavailable; no pixel-parity claim.'] }


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
		const messages = [{ role: 'user', text: 'Check the saved preference.' },
			{ role: 'assistant', text: 'I’ll read the recorded preference.', phase: 'commentary' },
			{ role: 'assistant', text: 'The saved preference is correct.', phase: 'final_answer' }]
		return { revision: 1, messages, partial: false, tasks: [], turn: 1, turns: {},
			timeline: messages.map((_, index) => ({ kind: 'message', index, turn: 1 })),
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
				return history
			}
			api.newConversation = async projectId => {
				const view = await base.newConversation(projectId)
				if ((await base.projects()).find(project => project.id === projectId)?.palId) {
					palId = view.id; palProject = projectId
				}
				return view
			}
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
						listener({ ...event, sessionId, projectId, revision: ++revision })
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
 const file = `transcript-content-${name}-20261007.png`
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
 const cold = page.locator('[data-activity-turn="1"] .activity-trigger')
 await expect(cold).toHaveAttribute('aria-label', 'Work details')
 await expect(cold).toHaveAttribute('aria-expanded', 'false')
 await expect(page.locator('.normal-transcript > .transcript-turn > [data-message-phase="final_answer"]')).toContainText('The saved preference is correct.')
 await cold.focus(); await page.keyboard.press('Enter')
 await expect(cold).toHaveAttribute('aria-expanded', 'true')
 await expect(page.locator('[data-message-phase="commentary"] .transcript-content-label')).toHaveText('Update')
 await expect(page.locator('.normal-transcript')).not.toContainText('Worked')
 await screenshot('history')
 receipt.checks.push('Cold commentary stays in keyboard-accessible work details, final reply remains standalone; unknown outcome is not labelled successful.')
 const at = await page.evaluate(() => window.__transcriptMotionProof.at)
 await emit([{ kind: 'prompt', prompt: 'Check the build and explain the result.', at }, state(true),
  update({ kind: 'agent_message_chunk', messageId: 'update', phase: 'commentary', text: 'I’ll check the build before changing anything.' }),
  update({ kind: 'agent_thought_chunk', blockId: 'public-reasoning', text: 'Use the recorded build result to decide what needs fixing.' }),
  ...['review', 'failed'].map(id => update({ kind: 'tool_call', toolCallId: id, title: 'exec', status: 'pending', view: { kind: 'terminal', command: id === 'review' ? 'pnpm build' : 'pnpm lint', output: '' } })),
  update({ kind: 'tool_call', toolCallId: 'failed', title: 'exec', status: 'failed', durationMs: 1200, view: { kind: 'terminal', command: 'pnpm lint', output: 'Source formatting differs in settings.ts.' } }),
  { kind: 'permission', request: { id: 'approval', sessionId: 'sample-thread-1', projectId: 'sample-app', calls: [{ id: 'review', name: 'exec', input: {}, isDestructive: false }] } }])
 await expect(page.locator('[data-reasoning-id="2:public-reasoning"] .transcript-content-label')).toHaveText('Reasoning')
 const group = page.locator('[data-activity-turn="2"] .tool-group > .tool-trigger')
 await expect(group).toContainText('1 waiting for approval, 1 failed')
 await group.click()
 const review = page.locator('[data-tool-call-id="review"]')
 await expect(review).toHaveAttribute('data-tool-state', 'waiting')
 await expect(review.locator('.tool-label')).toHaveText('Waiting to run pnpm build')
 await review.locator('.tool-trigger').focus(); await page.keyboard.press('Enter')
 await expect(review).toContainText('No output yet.')
 const failed = page.locator('[data-tool-call-id="failed"]')
 await expect(failed).toHaveAttribute('data-tool-state', 'failed')
 await expect(failed.locator('.tool-label')).toHaveText('Command failed: pnpm lint')
 await failed.locator('.tool-trigger').click()
 await expect(failed).toContainText('Source formatting differs in settings.ts.')
 await expect(page.locator('.normal-transcript > .working[aria-hidden="false"]')).toHaveCount(1)
 await expect(page.locator('.normal-transcript > .working')).toHaveAttribute('aria-label', 'Waiting for your decision')
 await screenshot('approval')
 await failed.scrollIntoViewIfNeeded(); await screenshot('failure-output')
 receipt.checks.push('One live status; exact waiting action, failed sibling and real output remain distinct; real disclosures support keyboard operation.')
 await emit([{ kind: 'permission-cleared', requestId: 'approval' },
  update({ kind: 'tool_call', toolCallId: 'review', title: 'exec', status: 'completed', durationMs: 900, view: { kind: 'terminal', command: 'pnpm build', output: 'Build completed successfully.' } }),
  update({ kind: 'tool_call', toolCallId: 'plan', title: 'task_update', status: 'pending', view: { kind: 'generic', label: 'Update the progress step' } }),
  update({ kind: 'tool_call', toolCallId: 'plan', title: 'task_update', status: 'completed', view: { kind: 'generic', label: '', visibility: 'hidden' } }),
  update({ kind: 'tool_call', toolCallId: 'cancel', title: 'open_document', status: 'pending', view: { kind: 'generic', label: 'Open the document' } }),
  update({ kind: 'tool_call', toolCallId: 'cancel', title: 'open_document', status: 'failed', view: { kind: 'generic', label: 'Open the document', outcome: 'cancelled' } }),
  update({ kind: 'agent_message', messageId: 'final', status: 'completed', stopReason: 'end_turn', textParts: [{ id: 'final-part', phase: 'final_answer', text: 'The build passed. Formatting still needs a fix in settings.ts.' }] }),
  update({ kind: 'agent_message_chunk', messageId: 'empty', phase: 'commentary', text: '\n  ' }),
  { ...update({ kind: 'turn_ended', stopReason: 'end_turn', reason: 'stop_condition', result: 'The build passed. Formatting still needs a fix in settings.ts.' }), at: at + 8000 }, state(false)])
 await settle()
 await expect(page.locator('[data-activity-turn="2"] .activity-trigger')).toHaveAttribute('aria-label', 'Worked for 8s')
 await expect(page.locator('.normal-transcript > .transcript-turn > [data-message-phase="final_answer"]').last()).toContainText('Formatting still needs a fix')
 const cancelled = page.locator('[data-tool-call-id="cancel"]')
 await expect(cancelled).toHaveAttribute('data-tool-state', 'cancelled')
 await expect(cancelled.locator('.tool-status')).toHaveText('Cancelled')
 await expect(cancelled.locator('button')).toHaveCount(0)
 await expect(page.locator('[data-tool-call-id="plan"]')).toContainText('Update the progress step')
 await expect(page.locator('[data-tool-call-id="plan"] button')).toHaveCount(0)
 await expect(page.locator('.normal-transcript > .notice')).toHaveCount(0)
 await screenshot('settled')
 receipt.checks.push('Actual cancelled outcomes are neutral; hidden successful receipts retain captions without empty buttons; normal configured stop is success, whitespace cannot hide the final reply.')
 await appearance('Light')
 await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' })
 await page.setViewportSize({ width: 720, height: 620 })
 await page.locator('.normal-transcript > .transcript-turn').last().scrollIntoViewIfNeeded()
 receipt.narrow = await page.locator('.normal-transcript').evaluate(root => ({ width: root.getBoundingClientRect().width, viewport: innerWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth, rootOverflow: root.scrollWidth > root.clientWidth, finiteAnimations: root.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).length }))
 assert.equal(receipt.narrow.documentOverflow, false); assert.equal(receipt.narrow.rootOverflow, false); assert.equal(receipt.narrow.finiteAnimations, 0)
 await screenshot('light-narrow-reduced')
 receipt.checks.push('Narrow light view has no transcript/document horizontal overflow; reduced motion has no finite transcript effects.')
 await appearance('Dark')
 await page.setViewportSize({ width: 1280, height: 900 }); await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' })
 await page.getByRole('button', { name: 'Create your first Pal', exact: true }).click()
 await page.locator('.pal-welcome').getByRole('button', { name: 'Customize your Pal', exact: true }).click()
 const customize = page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
 await customize.getByRole('textbox', { name: 'Pal name', exact: true }).fill('Transcript Pal')
 await customize.getByRole('button', { name: 'Save', exact: true }).click()
 await expect(customize).toHaveCount(0)
 await emit([{ kind: 'prompt', prompt: 'Tell me what you found.', at: at + 9000 }, state(true),
  update({ kind: 'agent_message', messageId: 'delivered', status: 'completed', content: 'Here is the result I checked.', stopReason: 'end_turn' }),
  update({ kind: 'agent_message_chunk', messageId: 'partial', phase: 'final_answer', text: 'An interrupted and undelivered reply.' })], true)
 await expect(page.locator('.pal-chat-transcript')).toContainText('Here is the result I checked.')
 await expect(page.locator('.pal-chat-transcript')).not.toContainText('An interrupted and undelivered reply.')
 await emit([update({ kind: 'agent_message', messageId: 'partial', status: 'completed', content: 'An interrupted and undelivered reply.', stopReason: 'cancelled' }), update({ kind: 'turn_ended', stopReason: 'error', reason: 'provider_error' }), state(false)], true)
 await expect(page.locator('.pal-chat-transcript')).not.toContainText('An interrupted and undelivered reply.')
 await expect(page.locator('.pal-chat-transcript')).toContainText('Here is the result I checked.')
 await expect(page.locator('.pal-chat-transcript')).toContainText('This turn could not finish.')
 await expect(page.locator('.normal-transcript, .turn-activity')).toHaveCount(0)
 await screenshot('pal-delivery')
 receipt.checks.push('Pal keeps its genuinely delivered reply while an explicitly interrupted partial stays undelivered after error; coding details do not enter friend chat.')
 assert.deepEqual(faults, [])
 receipt.apiErrors = await page.evaluate(() => window.__transcriptMotionProof.apiErrors)
 assert.deepEqual(receipt.apiErrors, [])
 receipt.passed = true
} catch (error) { receipt.error = { name: error.name, message: error.message }; process.exitCode = 1 }
finally {
 receipt.rendererErrors = faults
 await browser.close(); await server.close()
 await writeFile(join(artifacts, 'transcript-content-browser-proof-20261007.json'), `${JSON.stringify(receipt, null, 2)}\n`)
 process.stdout.write(`${JSON.stringify({ passed: receipt.passed, checks: receipt.checks, error: receipt.error })}\n`)
}
