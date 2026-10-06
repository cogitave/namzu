/** Real Vite renderer, synthetic DesktopEvents, no native/model/guest actions.
 * Motion assertions pause browser animations and select their timeline frames;
 * elapsed wall time never decides an outcome.
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
	computerActions: 0, nativeActions: 0, viewport: { width: 1280, height: 900 }, frames: {}, checks: [],
	supplements: 'transcript-single-live-status-motion-proof-20261006.json',
	timelineControl: 'browser animations paused at creation and selected by explicit currentTime', singleLiveStatus: [] }

await page.addInitScript(() => {
	let api
	let normalId = 'sample-thread-1'
	let palId
	let normalProject = 'sample-app'
	let palProject
	const listeners = new Set()
	const at = Date.UTC(2026, 9, 6, 15)
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
		const messages = [
			{ role: 'user', text: 'Historical request' },
			{ role: 'assistant', text: 'Historical completed answer', messageId: 'historical-answer', status: 'completed', phase: 'final_answer' },
		]
		return {
			revision: 1, messages, partial: false, tasks: [], turn: 1,
			turns: { 1: { startedAt: at - 9000, endedAt: at, stopReason: 'end_turn', reason: 'end_turn', result: 'Historical completed answer' } },
			timeline: [{ kind: 'message', index: 0, turn: 1 }, { kind: 'reasoning', id: '1:historical-thought', turn: 1 },
				{ kind: 'tool', id: '1:historical-tool', turn: 1 }, { kind: 'message', index: 1, turn: 1 }],
			running: false, queued: [], queuedItems: [], permissions: [], activeToolIds: [], responding: false,
			reasoning: { '1:historical-thought': { text: 'Historical reasoning stays still', status: 'completed', turn: 1 } },
			tools: { '1:historical-tool': { kind: 'tool_call', toolCallId: 'historical-tool', title: 'exec', status: 'completed', durationMs: 700,
				view: { kind: 'terminal', command: 'Read historical fixture', output: 'Historical result' } } },
		}
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
const prompt = (text, at) => ({ kind: 'prompt', prompt: text, at })
const phase = '.normal-transcript > .working'
const label = `${phase} .transcript-phase-text`
const entryCalls = () => page.evaluate(() => window.__transcriptMotionProof.animationCalls.filter(call => call.entry !== null))
async function renderFrame() {
	await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}
async function settleFinite() {
	await page.evaluate(async () => {
		for (const animation of document.getAnimations()) {
			const timing = animation.effect?.getComputedTiming()
			if (typeof timing?.endTime === 'number' && Number.isFinite(timing.endTime)) {
				animation.finish()
				await animation.finished.catch(() => {})
			}
		}
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
	})
}
async function frames(selector, id, { finish = false, interruptedAt } = {}) {
	return page.locator(selector).evaluate((element, { id, finish, interruptedAt }) => {
		const proof = window.__transcriptMotionProof
		const animation = element.getAnimations().find(effect => effect.id === id)
		if (!animation) throw new Error(`No ${id} animation on ${element.className}`)
		if (!proof.animations.has(animation)) proof.animations.set(animation, proof.nextAnimation++)
		animation.pause()
		const duration = Number(animation.effect.getTiming().duration)
		const result = { identity: proof.animations.get(animation), id, duration,
			easing: animation.effect.getTiming().easing, keyframes: animation.effect.getKeyframes(), values: [] }
		for (const time of [0, duration / 2, duration]) {
			animation.currentTime = time
			const style = getComputedStyle(element)
			result.values.push({ time, opacity: Number(style.opacity), transform: style.transform, height: style.height })
		}
		if (finish) animation.finish()
		else animation.currentTime = interruptedAt ?? duration / 2
		return result
	}, { id, finish, interruptedAt })
}
async function presenceFrames({ interruptedAt, finish = false } = {}) {
	return page.locator(phase).evaluate((element, { interruptedAt, finish }) => {
		const effects = element.getAnimations()
		const frame = effects.find(effect => effect.id === 'namzu-transcript-status-frame')
		const opacity = effects.find(effect => effect.id === 'namzu-transcript-status-opacity')
		if (!frame || !opacity) throw new Error('Expected paired presence frame and opacity effects.')
		for (const effect of [frame, opacity]) effect.pause()
		const durations = { frame: Number(frame.effect.getTiming().duration), opacity: Number(opacity.effect.getTiming().duration) }
		const sample = time => {
			for (const effect of [frame, opacity]) effect.currentTime = Math.min(time, Number(effect.effect.getTiming().duration))
			const style = getComputedStyle(element)
			return { time, frameTime: frame.currentTime, opacityTime: opacity.currentTime,
				opacity: Number(style.opacity), height: element.getBoundingClientRect().height,
				transform: style.transform, display: style.display }
		}
		const result = { durations, easing: { frame: frame.effect.getTiming().easing, opacity: opacity.effect.getTiming().easing },
			timeline: 'paired effects sampled at the same explicit time', values: [0, 60, 80, 120, 160].map(sample) }
		if (interruptedAt !== undefined) result.interrupted = sample(interruptedAt)
		if (finish) { opacity.finish(); frame.finish() }
		return result
	}, { interruptedAt, finish })
}
async function finishOpacityBeforeFrame() {
	return page.locator(phase).evaluate(async element => {
		const effects = element.getAnimations()
		const frame = effects.find(effect => effect.id === 'namzu-transcript-status-frame')
		const opacity = effects.find(effect => effect.id === 'namzu-transcript-status-opacity')
		frame.currentTime = 120
		opacity.finish()
		await opacity.finished.catch(() => {})
		await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
		const result = { frameTime: frame.currentTime, framePlayState: frame.playState,
			display: getComputedStyle(element).display, height: element.getBoundingClientRect().height }
		return result
	})
}
async function presenceSnapshot() {
	return page.locator(phase).evaluate(element => ({
		display: getComputedStyle(element).display, opacity: Number(getComputedStyle(element).opacity),
		height: element.getBoundingClientRect().height, ariaHidden: element.getAttribute('aria-hidden'),
		inert: element.inert, outgoing: element.querySelectorAll('[data-transcript-phase-outgoing]').length,
	}))
}
async function singleStatus(expected) {
	await expect(page.locator(phase)).toHaveAttribute('aria-label', expected)
	await expect(page.locator(label)).toHaveCount(1)
	await expect(page.locator(label)).toHaveText(expected)
	await expect(page.locator('.normal-transcript [data-transcript-phase-outgoing]')).toHaveCount(0)
	await expect(page.locator('[data-activity-turn="2"] .activity-trigger')).toHaveAttribute('aria-label', 'Work details')
	receipt.singleLiveStatus.push({ label: expected, phaseLabels: 1, outgoingLabels: 0 })
}
function assertCalmEntry(result) {
	assert.equal(result.duration, 120)
	assert.equal(result.easing, 'ease-out')
	assert.equal(result.values[0].opacity, 0.65)
	assert(result.values[1].opacity > 0.65 && result.values[1].opacity < 1)
	assert.equal(result.values[2].opacity, 1)
	assert(result.values.every(value => value.transform === 'none'))
	assert(result.keyframes.every(frame => !frame.transform))
}
async function capture(name) {
	const filename = `calm-transcript-${name}-20261006.png`
	await page.screenshot({ path: join(artifacts, filename) })
	return filename
}

try {
	await page.goto(origin)
	await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
	await page.locator('[data-project-group="sample-app"]').getByRole('button', { name: 'Refine navigation', exact: true }).click()
	await expect(page.locator('.conversation-body')).toContainText('Historical completed answer')
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEditable()
	assert.deepEqual(await entryCalls(), [], 'stored history mount must not animate')
	await expect(page.locator('[data-activity-turn="1"] .activity-trigger')).toHaveAttribute('aria-label', 'Worked for 9s')
	await page.locator('[data-activity-turn="1"] .activity-trigger').click()
	await expect(page.locator('[data-reasoning-id="1:historical-thought"]')).toBeVisible()
	assert.deepEqual(await entryCalls(), [], 'revealing stored detail must not replay entries')
	receipt.checks.push('historical mount and opening stored work details have no entry effects')
	const at = await page.evaluate(() => window.__transcriptMotionProof.at)

	await emit([prompt('Calm live fixture', at + 1000), state(true)])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'working')
	receipt.frames.reveal = await presenceFrames({ interruptedAt: 80 })
	assert.deepEqual(receipt.frames.reveal.durations, { frame: 160, opacity: 120 })
	assert.equal(receipt.frames.reveal.values[0].opacity, 0)
	assert.equal(receipt.frames.reveal.values.at(-1).opacity, 1)
	receipt.opacityFinishBeforeRevealFrame = await finishOpacityBeforeFrame()
	assert.equal(receipt.opacityFinishBeforeRevealFrame.framePlayState, 'paused')
	assert.equal(receipt.opacityFinishBeforeRevealFrame.frameTime, 120)
	await settleFinite()
	const revealSettled = await presenceSnapshot()
	assert.equal(revealSettled.opacity, 1)
	assert(revealSettled.height > 0)
	receipt.checks.push('reveal uses opacity120ms and frame160ms; opacity finish does not cancel the unfinished frame')

	await emit([update({ kind: 'agent_thought_chunk', turnId: 'calm-turn-2', messageId: 'live-thought', blockId: 'live-thought', text: 'Inspect the calm fixture.' })])
	const thought = '[data-reasoning-id="2:live-thought"]'
	await expect(page.locator(thought)).toHaveText('Inspect the calm fixture.')
	receipt.frames.reasoningEntry = await frames(thought, 'namzu-transcript-entry')
	assertCalmEntry(receipt.frames.reasoningEntry)
	await singleStatus('Thinking')
	receipt.frames.phase = await frames(label, 'namzu-transcript-phase-in', { interruptedAt: 60 })
	assertCalmEntry(receipt.frames.phase)
	const thoughtCount = (await entryCalls()).filter(call => call.entry === 'reasoning-2:live-thought').length
	await emit([update({ kind: 'agent_thought_chunk', turnId: 'calm-turn-2', messageId: 'live-thought', blockId: 'live-thought', text: ' More of the same thought.' })])
	await expect(page.locator(thought)).toContainText('same thought')
	assert.equal((await frames(thought, 'namzu-transcript-entry')).identity, receipt.frames.reasoningEntry.identity)
	assert.equal((await entryCalls()).filter(call => call.entry === 'reasoning-2:live-thought').length, thoughtCount)

	await emit([update({ kind: 'tool_call', toolCallId: 'live-tool', title: 'exec', status: 'pending', view: { kind: 'terminal', command: 'Read calm fixture', output: '' } })])
	const tool = '[data-transcript-entry-key="tool-2:live-tool"]'
	await expect(page.locator(tool)).toContainText('Read calm fixture')
	await singleStatus('Working')
	receipt.frames.phaseReversal = await frames(label, 'namzu-transcript-phase-in')
	assert(Math.abs(receipt.frames.phaseReversal.values[0].opacity - receipt.frames.phase.values[1].opacity) < 0.02)
	assert.equal(receipt.frames.phaseReversal.duration, 120)
	receipt.frames.toolEntry = await frames(tool, 'namzu-transcript-entry')
	assertCalmEntry(receipt.frames.toolEntry)
	await emit([update({ kind: 'tool_call', toolCallId: 'live-tool', title: 'exec', status: 'pending', progress: { message: 'Fixture progress', fraction: 0.5 }, view: { kind: 'terminal', command: 'Read calm fixture', output: '' } })])
	assert.equal((await frames(tool, 'namzu-transcript-entry')).identity, receipt.frames.toolEntry.identity)
	await settleFinite()
	const styles = await page.locator(phase).evaluate(element => ({
		labelBackground: getComputedStyle(element.querySelector('.working-label')).backgroundImage,
		labelAnimation: getComputedStyle(element.querySelector('.working-label')).animationName,
		dotWidth: getComputedStyle(element, '::before').width,
		dotAnimation: getComputedStyle(element, '::before').animationName,
		dotDuration: getComputedStyle(element, '::before').animationDuration,
	}))
	assert.equal(styles.labelBackground, 'none')
	assert.equal(styles.labelAnimation, 'none')
	assert.equal(styles.dotWidth, '5px')
	assert.equal(styles.dotAnimation, 'transcript-status-breathe')
	assert.equal(styles.dotDuration, '1.8s')
	receipt.statusStyles = styles
	await emit([{ kind: 'permission', request: { id: 'calm-review', sessionId: 'sample-thread-1', projectId: 'sample-app', calls: [] } }])
	await singleStatus('Waiting for your decision')
	await settleFinite()
	assert.equal(await page.locator(phase).evaluate(element => getComputedStyle(element, '::before').animationName), 'none')
	await emit([{ kind: 'permission-cleared', requestId: 'calm-review' }])
	await singleStatus('Working')
	await settleFinite()
	receipt.checks.push('single phase label brightens120ms; interrupted phase reversal preserves opacity without ghost labels; shimmer replaced by a5px breathing dot, waiting stays still')

	await emit([update({ kind: 'tool_call', toolCallId: 'live-tool', title: 'exec', status: 'completed', durationMs: 200, view: { kind: 'terminal', command: 'Read calm fixture', output: 'Checked' } }),
		update({ kind: 'agent_message_chunk', turnId: 'calm-turn-2', messageId: 'live-answer', phase: 'final_answer', text: 'Visible calm answer' })])
	const answer = '.normal-transcript [data-message-phase="final_answer"][data-timeline-turn="2"]'
	await expect(page.locator(answer)).toHaveText('Visible calm answer')
	receipt.frames.messageEntry = await frames(answer, 'namzu-transcript-entry')
	assertCalmEntry(receipt.frames.messageEntry)
	await emit([update({ kind: 'agent_message_chunk', turnId: 'calm-turn-2', messageId: 'live-answer', phase: 'final_answer', text: ' continued' })])
	assert.equal((await frames(answer, 'namzu-transcript-entry')).identity, receipt.frames.messageEntry.identity)
	await settleFinite()
	const callsBeforeCollapse = (await entryCalls()).length
	const details = page.locator('[data-activity-turn="2"] .activity-trigger')
	await details.click()
	await expect(details).toHaveAttribute('aria-expanded', 'false')
	await settleFinite()
	await details.click()
	await expect(details).toHaveAttribute('aria-expanded', 'true')
	await settleFinite()
	assert.equal((await entryCalls()).length, callsBeforeCollapse)
	receipt.screenshots = [await capture('live')]
	receipt.checks.push('reasoning/tool/message entries brighten .65→1 over120ms without translation; chunks, progress, and reopening work details never replay')

	await emit([update({ kind: 'agent_message', turnId: 'calm-turn-2', messageId: 'live-answer', status: 'completed', phase: 'final_answer', content: 'Verified calm answer' }),
		{ ...update({ kind: 'turn_ended', turnId: 'calm-turn-2', stopReason: 'end_turn', reason: 'end_turn', result: 'Verified calm answer' }), at: at + 9000 }, state(false)])
	await expect(page.locator('[data-activity-turn="2"] .activity-trigger')).toHaveAttribute('aria-label', 'Worked for 8s')
	await expect(page.locator(phase)).toHaveAttribute('aria-hidden', 'true')
	assert.equal(await page.locator(phase).evaluate(element => element.inert), true)
	receipt.frames.exit = await presenceFrames({ interruptedAt: 80 })
	assert.equal(receipt.frames.exit.values.at(-1).opacity, 0)
	assert.equal(receipt.frames.exit.values.at(-1).height, 0)
	receipt.opacityFinishBeforeExitFrame = await finishOpacityBeforeFrame()
	assert.equal(receipt.opacityFinishBeforeExitFrame.framePlayState, 'paused')
	assert.equal(receipt.opacityFinishBeforeExitFrame.frameTime, 120)
	assert.notEqual(receipt.opacityFinishBeforeExitFrame.display, 'none')
	assert(receipt.opacityFinishBeforeExitFrame.height > 0)
	// At the real120ms boundary the opacity effect has finished while the
	// frame has40ms remaining. Never revive the controller's finished effect.
	const interrupted = { interrupted: await presenceSnapshot() }
	receipt.interruptedPresence = interrupted.interrupted
	await emit([prompt('Reverse unfinished calm exit', at + 10000), state(true)])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'working')
	receipt.frames.reversal = await presenceFrames({ finish: true })
	assert(Math.abs(receipt.frames.reversal.values[0].opacity - interrupted.interrupted.opacity) < 0.02)
	assert(Math.abs(receipt.frames.reversal.values[0].height - interrupted.interrupted.height) < 0.5)
	assert.equal(receipt.frames.reversal.values.at(-1).opacity, 1)
	await renderFrame()
	receipt.settledReversal = await presenceSnapshot()
	assert.equal(receipt.settledReversal.opacity, 1)
	assert(receipt.settledReversal.height > 0)
	assert.equal(receipt.settledReversal.ariaHidden, 'false')
	assert.equal(receipt.settledReversal.outgoing, 0)
	await emit([update({ kind: 'agent_thought_chunk', turnId: 'calm-turn-3', messageId: 'paused-thought', blockId: 'paused-thought', text: 'Retain interrupted work.' }),
		{ ...update({ kind: 'turn_ended', turnId: 'calm-turn-3', stopReason: 'cancelled', reason: 'paused', result: '' }), at: at + 12000 }, state(false)])
	await expect(page.locator('[data-activity-turn="3"] .activity-trigger')).toHaveAttribute('aria-label', 'Paused · 2s')
	await settleFinite()
	receipt.settledExit = await presenceSnapshot()
	assert.equal(receipt.settledExit.display, 'none')
	assert.equal(receipt.settledExit.height, 0)
	assert.equal(receipt.settledExit.ariaHidden, 'true')
	assert.equal(receipt.settledExit.inert, true)
	receipt.checks.push('exit remains framed until160ms frame finish, reverses from actual interrupted opacity/height, then fully hides; completed and paused duration labels stay truthful')

	const beforeNavigation = (await entryCalls()).length
	await page.locator('[data-project-group="sample-app"]').getByRole('button', { name: 'Polish empty states', exact: true }).click()
	await expect(page.locator('.conversation-body')).toContainText('polish empty states')
	await page.locator('.conversation-tab[data-tab-id="sample-thread-1"]').click()
	await expect(page.locator('.conversation-body')).toContainText('Verified calm answer')
	assert.equal((await entryCalls()).length, beforeNavigation)
	receipt.checks.push('historical tab navigation preserves retained messages without replaying entry effects')

	await page.emulateMedia({ reducedMotion: 'reduce' })
	const reducedBefore = (await entryCalls()).length
	await emit([prompt('Reduced calm fixture', at + 13000), state(true), update({ kind: 'agent_thought_chunk', turnId: 'calm-turn-4', messageId: 'reduced-thought', blockId: 'reduced-thought', text: 'Reduced thought.' })])
	await expect(page.locator('[data-reasoning-id="4:reduced-thought"]')).toBeVisible()
	assert.equal((await entryCalls()).length, reducedBefore)
	receipt.reducedMotion = await page.locator('.normal-transcript').evaluate(root => ({
		animations: root.getAnimations({ subtree: true }).map(effect => ({ id: effect.id, duration: effect.effect?.getTiming().duration })),
		panelTransition: getComputedStyle(root.querySelector('[data-activity-turn="4"] [data-slot="collapsible-panel"]')).transitionDuration,
		dotAnimation: getComputedStyle(root.querySelector(':scope > .working'), '::before').animationName,
		outgoing: root.querySelectorAll('[data-transcript-phase-outgoing]').length,
	}))
	assert.deepEqual(receipt.reducedMotion.animations, [])
	assert.equal(receipt.reducedMotion.panelTransition, '0s')
	assert.equal(receipt.reducedMotion.dotAnimation, 'none')
	assert.equal(receipt.reducedMotion.outgoing, 0)
	receipt.screenshots.push(await capture('reduced'))
	receipt.checks.push('reduced motion disables all transcript effects, dot breathing, and disclosure transitions')
	assert.deepEqual(faults, [])
	receipt.apiErrors = await page.evaluate(() => window.__transcriptMotionProof.apiErrors)
	assert.deepEqual(receipt.apiErrors, [])
	receipt.passed = true
} catch (error) {
	receipt.error = { name: error.name, message: error.message }
	process.exitCode = 1
} finally {
	receipt.rendererErrors = faults
	await browser.close()
	await server.close()
	await writeFile(join(artifacts, 'calm-transcript-motion-browser-proof-20261006.json'), `${JSON.stringify(receipt, null, 2)}\n`)
	process.stdout.write(`${JSON.stringify({ passed: receipt.passed, checks: receipt.checks, error: receipt.error })}\n`)
}
