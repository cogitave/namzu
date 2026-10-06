/** Real Vite renderer, synthetic DesktopEvents, no native/model/guest actions.
 * Motion assertions pause browser animations and select their timeline frames;
 * elapsed wall time never decides an outcome.
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
	supplements: 'transcript-reference-motion-proof-20261006.json', singleLiveStatus: [] }

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
			if ([150, 200, 300].includes(Number(animation.effect.getTiming().duration))) animation.pause()
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
async function frames(selector, duration, { finish = true, id } = {}) {
	return page.locator(selector).evaluate((element, { duration, finish, id }) => {
		const proof = window.__transcriptMotionProof
		const own = element.getAnimations().filter(animation => Number(animation.effect?.getTiming().duration) === duration && (!id || animation.id === id))
		if (!own.length) throw new Error(`No ${duration}ms animation on ${element.className}`)
		const animation = own[0]
		if (!proof.animations.has(animation)) proof.animations.set(animation, proof.nextAnimation++)
		animation.pause()
		const result = { id: proof.animations.get(animation), duration, easing: animation.effect.getTiming().easing,
			keyframes: animation.effect.getKeyframes(), values: [] }
		for (const time of [0, duration / 2, duration]) {
			animation.currentTime = time
			const style = getComputedStyle(element)
			result.values.push({ time, opacity: Number(style.opacity), transform: style.transform, height: style.height })
		}
		if (finish) animation.finish()
		else animation.currentTime = duration / 2
		return result
	}, { duration, finish, id })
}
async function presenceFrames(selector, interruptedAt) {
	return page.locator(selector).evaluate((element, interruptedAt) => {
		const proof = window.__transcriptMotionProof
		const animations = element.getAnimations()
		const height = animations.find(animation => animation.id === 'namzu-transcript-status-frame')
		const opacity = animations.find(animation => animation.id === 'namzu-transcript-status-opacity')
		if (!height || !opacity) throw new Error('Expected paired presence frame and opacity effects.')
		const metadata = animation => {
			animation.pause()
			if (!proof.animations.has(animation)) proof.animations.set(animation, proof.nextAnimation++)
			return { id: proof.animations.get(animation), duration: Number(animation.effect.getTiming().duration),
				easing: animation.effect.getTiming().easing, keyframes: animation.effect.getKeyframes(),
				timeline: 'paired frame and opacity advance on the same 300ms clock', values: [] }
		}
		const result = { height: metadata(height), opacity: metadata(opacity) }
		const sample = time => {
			for (const animation of [height, opacity]) animation.currentTime = Math.min(time, Number(animation.effect.getTiming().duration))
			const style = getComputedStyle(element)
			return { time, frameTime: height.currentTime, opacityTime: opacity.currentTime,
				opacity: Number(style.opacity), transform: style.transform, height: style.height }
		}
		for (const time of [0, 100, 150, 200, 300]) {
			const value = sample(time)
			result.height.values.push(value)
			result.opacity.values.push(value)
		}
		if (interruptedAt !== undefined) result.interrupted = sample(interruptedAt)
		else { height.finish(); opacity.finish() }
		return result
	}, interruptedAt)
}
async function presenceSnapshot(selector) {
	return page.locator(selector).evaluate(element => ({
		display: getComputedStyle(element).display, opacity: Number(getComputedStyle(element).opacity),
		height: element.getBoundingClientRect().height, ariaHidden: element.getAttribute('aria-hidden'),
		inert: element.inert, outgoing: element.querySelectorAll('[data-transcript-phase-outgoing]').length,
	}))
}
async function capture(name) {
	const filename = `transcript-single-live-status-${name}-20261006.png`
	await page.screenshot({ path: join(artifacts, filename) })
	return filename
}

async function assertSingleLiveStatus(turn, label, { details = true, open } = {}) {
	const root = page.locator('.normal-transcript')
	const live = root.locator(':scope > .working[aria-live="polite"][aria-hidden="false"]')
	await expect(live).toHaveCount(1)
	await expect(live).toHaveAttribute('aria-label', label)
	await expect(live.locator('.transcript-phase-text:not([data-transcript-phase-outgoing])')).toHaveText(label)
	await expect(root.locator('[data-activity-turn="1"] .activity-trigger')).toHaveAttribute('aria-label', 'Worked for 9s')
	const disclosure = root.locator(`[data-activity-turn="${turn}"] .activity-trigger`)
	if (details) {
		await expect(disclosure).toHaveAttribute('aria-label', 'Work details')
		if (open !== undefined) await expect(disclosure).toHaveAttribute('aria-expanded', String(open))
	} else await expect(disclosure).toHaveCount(0)
	const visiblePhases = await root.locator('.transcript-phase-text:not([data-transcript-phase-outgoing])').evaluateAll(nodes =>
		nodes.filter(node => node.getClientRects().length && ['Thinking', 'Working', 'Waiting for your decision'].includes(node.textContent))
			.map(node => node.textContent),
	)
	assert.deepEqual(visiblePhases, [label], 'one current visible phase layer belongs to the single live status')
	receipt.singleLiveStatus.push({ turn, label, details, open: open ?? null, activeStatusOwners: 1,
		visiblePhaseLabels: visiblePhases, historicalLabel: 'Worked for 9s' })
}

try {
	await page.goto(origin)
	await expect(page.getByRole('status', { name: 'Design preview', exact: true })).toBeVisible()
	await page.locator('[data-project-group="sample-app"]').getByRole('button', { name: 'Refine navigation', exact: true }).click()
	await expect(page.locator('.conversation-body')).toContainText('Historical completed answer')
	await expect(page.getByRole('textbox', { name: 'Message Namzu', exact: true })).toBeEditable()
	await expect(page.locator('.normal-transcript')).toHaveCount(1)
	const at = await page.evaluate(() => window.__transcriptMotionProof.at)
	const phase = '.normal-transcript > .working'
	const incoming = `${phase} .transcript-phase-text:not([data-transcript-phase-outgoing])`
	const outgoing = `${phase} [data-transcript-phase-outgoing]`
	const entryCalls = () => page.evaluate(() => window.__transcriptMotionProof.animationCalls.filter(call => call.duration === 150))
	assert.deepEqual(await entryCalls(), [], 'historical mount must not animate entries')
	await expect(page.locator('[data-activity-turn="1"] .activity-trigger')).toHaveAttribute('aria-label', 'Worked for 9s')
	await page.evaluate(() => {
		const root = document.querySelector('[data-activity-turn="1"]')
		const proof = window.__transcriptMotionProof
		const observer = new MutationObserver(() => {
			const panel = root.querySelector('[data-slot="collapsible-panel"]')
			if (!panel) return
			getComputedStyle(panel).height
			const animation = panel.getAnimations().find(effect => Number(effect.effect?.getTiming().duration) === 200)
			if (!animation) return
			observer.disconnect()
			animation.pause()
			const values = []
			for (const time of [0, 100, 200]) {
				animation.currentTime = time
				values.push({ time, height: Number.parseFloat(getComputedStyle(panel).height) })
			}
			proof.panelFrames = { duration: 200, values }
			animation.finish()
		})
		observer.observe(root, { attributes: true, childList: true, subtree: true })
		root.querySelector('.activity-trigger').click()
	})
	await expect.poll(() => page.evaluate(() => window.__transcriptMotionProof.panelFrames ?? null)).not.toBeNull()
	receipt.frames.collapse = await page.evaluate(() => window.__transcriptMotionProof.panelFrames)
	assert(receipt.frames.collapse.values[1].height > receipt.frames.collapse.values[0].height)
	assert(receipt.frames.collapse.values[1].height < receipt.frames.collapse.values[2].height)
	await expect(page.locator('[data-reasoning-id="1:historical-thought"]')).toBeVisible()
	assert.deepEqual(await entryCalls(), [], 'opening stored activity must not animate its entries')
	receipt.checks.push('historical mount/disclosure stays still; existing activity height travel is 200ms')

	await emit([prompt('Live motion fixture', at + 1000), state(true)])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'working')
	const reveal = await presenceFrames(phase)
	receipt.frames.revealHeight = reveal.height
	receipt.frames.revealOpacity = reveal.opacity
	assert.equal(receipt.frames.revealOpacity.values[0].opacity, 0)
	assert.equal(receipt.frames.revealOpacity.values.at(-1).opacity, 1)
	await settleFinite()

	await emit([update({ kind: 'agent_thought_chunk', turnId: 'motion-turn-2', messageId: 'live-thought', blockId: 'live-thought', text: 'Inspect the visible fixture.' })])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'thinking')
	const reasoning = '[data-reasoning-id="2:live-thought"]'
	await expect(page.locator(reasoning)).toHaveText('Inspect the visible fixture.')
	receipt.frames.reasoningEntry = await frames(reasoning, 150, { finish: false })
	assert.equal(receipt.frames.reasoningEntry.values[0].opacity, 0)
	assert.equal(receipt.frames.reasoningEntry.values[2].opacity, 1)
	assert.match(receipt.frames.reasoningEntry.values[0].transform, /(?:matrix\(1, 0, 0, 1, 0, 4\)|translateY\(4px\))/)
	receipt.frames.phaseIn = await frames(incoming, 300, { finish: false, id: 'namzu-transcript-phase-in' })
	receipt.frames.phaseOut = await frames(outgoing, 300, { finish: false, id: 'namzu-transcript-phase-out' })
	await expect(page.locator(outgoing)).toHaveAttribute('aria-hidden', 'true')
	assert.equal(receipt.frames.phaseIn.values[0].opacity, 0)
	assert.equal(receipt.frames.phaseOut.values[2].opacity, 0)
	assert(receipt.frames.phaseIn.values[1].opacity > 0 && receipt.frames.phaseIn.values[1].opacity < 1)
	assert(receipt.frames.phaseOut.values[1].opacity > 0 && receipt.frames.phaseOut.values[1].opacity < 1)
	const countBeforeChunk = (await entryCalls()).filter(call => call.entry === 'reasoning-2:live-thought').length
	await emit([update({ kind: 'agent_thought_chunk', turnId: 'motion-turn-2', messageId: 'live-thought', blockId: 'live-thought', text: ' Keep this same thought.' })])
	await expect(page.locator(reasoning)).toContainText('same thought')
	const continuedReasoning = await frames(reasoning, 150, { finish: false })
	assert.equal(continuedReasoning.id, receipt.frames.reasoningEntry.id)
	assert.equal((await entryCalls()).filter(call => call.entry === 'reasoning-2:live-thought').length, countBeforeChunk)
	await settleFinite()
	await assertSingleLiveStatus(2, 'Thinking', { open: true })
	const liveDisclosure = page.locator('[data-activity-turn="2"] .activity-trigger')
	const callsBeforeDisclosure = (await entryCalls()).length
	await liveDisclosure.click()
	await expect(liveDisclosure).toHaveAttribute('aria-expanded', 'false')
	await settleFinite()
	await expect(page.locator(reasoning)).not.toBeVisible()
	await assertSingleLiveStatus(2, 'Thinking', { open: false })
	await emit([update({ kind: 'agent_thought_chunk', turnId: 'motion-turn-2', messageId: 'live-thought', blockId: 'live-thought', text: ' Preserve the reader collapse.' })])
	await assertSingleLiveStatus(2, 'Thinking', { open: false })
	await liveDisclosure.click()
	await expect(liveDisclosure).toHaveAttribute('aria-expanded', 'true')
	await settleFinite()
	await expect(page.locator(reasoning)).toContainText('Preserve the reader collapse.')
	await assertSingleLiveStatus(2, 'Thinking', { open: true })
	assert.equal((await entryCalls()).length, callsBeforeDisclosure, 'opening/collapsing existing live entries must not replay entry effects')

	await emit([update({ kind: 'tool_call', toolCallId: 'live-tool', title: 'exec', status: 'pending', view: { kind: 'terminal', command: 'Read visible fixture', output: '' } })])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'tools')
	const tool = '[data-transcript-entry-key="tool-2:live-tool"]'
	await expect(page.locator(tool)).toContainText('Running Read visible fixture')
	receipt.frames.toolEntry = await frames(tool, 150, { finish: false })
	await emit([update({ kind: 'tool_call', toolCallId: 'live-tool', title: 'exec', status: 'pending', view: { kind: 'terminal', command: 'Read visible fixture', output: '' }, progress: { message: 'Fixture progress', fraction: 0.5 } })])
	await expect(page.locator(tool)).toContainText('Read visible fixture')
	assert.equal((await frames(tool, 150, { finish: false })).id, receipt.frames.toolEntry.id)
	await settleFinite()
	await assertSingleLiveStatus(2, 'Working', { open: true })
	await liveDisclosure.click()
	await expect(liveDisclosure).toHaveAttribute('aria-expanded', 'false')
	await settleFinite()
	await assertSingleLiveStatus(2, 'Working', { open: false })
	receipt.screenshots = [await capture('collapsed')]
	await liveDisclosure.click()
	await expect(liveDisclosure).toHaveAttribute('aria-expanded', 'true')
	await settleFinite()
	await emit([{ kind: 'permission', request: { id: 'motion-review', sessionId: 'sample-thread-1', projectId: 'sample-app', calls: [] } }])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'waiting')
	await settleFinite()
	await assertSingleLiveStatus(2, 'Waiting for your decision', { open: true })
	await emit([{ kind: 'permission-cleared', requestId: 'motion-review' }])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'tools')
	await settleFinite()
	await assertSingleLiveStatus(2, 'Working', { open: true })
	await emit([update({ kind: 'tool_call', toolCallId: 'live-tool', title: 'exec', status: 'completed', durationMs: 250, view: { kind: 'terminal', command: 'Read visible fixture', output: 'Visible fixture checked' } })])
	await emit([update({ kind: 'agent_message_chunk', turnId: 'motion-turn-2', messageId: 'live-answer', phase: 'final_answer', text: 'Visible streamed answer' })])
	const answer = '.normal-transcript [data-message-phase="final_answer"][data-timeline-turn="2"]'
	await expect(page.locator(answer)).toHaveText('Visible streamed answer')
	receipt.frames.messageEntry = await frames(answer, 150, { finish: false })
	await emit([update({ kind: 'agent_message_chunk', turnId: 'motion-turn-2', messageId: 'live-answer', phase: 'final_answer', text: ' continued' })])
	await expect(page.locator(answer)).toContainText('continued')
	assert.equal((await frames(answer, 150, { finish: false })).id, receipt.frames.messageEntry.id)
	await settleFinite()
	receipt.checks.push('live reasoning/tool/message entries fade and rise4px for150ms once; chunks/progress preserve animation identity')
	receipt.screenshots.push(await capture('live'))
	receipt.checks.push('one live phase+elapsed owner across expanded/collapsed current Work details; reader collapse survives chunks, older Worked for9s retained, waiting stays truthful')

	await emit([update({ kind: 'agent_message', turnId: 'motion-turn-2', messageId: 'live-answer', status: 'completed', content: 'Verified visible answer', phase: 'final_answer' }),
		{ ...update({ kind: 'turn_ended', turnId: 'motion-turn-2', stopReason: 'end_turn', reason: 'end_turn', result: 'Verified visible answer' }), at: at + 9000 }, state(false)])
	await expect(page.locator('[data-activity-turn="2"] .activity-trigger')).toHaveAttribute('aria-label', 'Worked for 8s')
	await expect(page.locator(phase)).toHaveAttribute('aria-hidden', 'true')
	assert.equal(await page.locator(phase).evaluate(node => node.inert), true)
	const exit = await presenceFrames(phase, 100)
	receipt.frames.exitHeight = exit.height
	receipt.frames.exitOpacity = exit.opacity
	receipt.interruptedPresenceExit = exit.interrupted
	assert.equal(exit.opacity.values.at(-1).opacity, 0, 'paired exit timeline must end transparent at300ms')
	assert.equal(Number.parseFloat(exit.height.values.at(-1).height), 0, 'paired exit timeline must end at zero height')
	const beforeReverse = await page.locator(phase).evaluate(node => ({ opacity: Number(getComputedStyle(node).opacity), height: node.getBoundingClientRect().height }))
	await emit([prompt('Reverse exit before it settles', at + 10000), state(true)])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'working')
	await expect(page.locator(phase)).toHaveAttribute('aria-hidden', 'false')
	const reversed = await presenceFrames(phase)
	receipt.frames.reversedPresence = reversed.opacity
	receipt.reversedPresenceFrame = reversed.height
	assert(Math.abs(receipt.frames.reversedPresence.values[0].opacity - beforeReverse.opacity) < 0.02, 'presence reversal must start at its visible opacity')
	assert.equal(reversed.opacity.values.at(-1).opacity, 1, 'paired reversed presence must end opaque at300ms')
	await settleFinite()
	receipt.settledPresenceReversal = await presenceSnapshot(phase)
	assert.equal(receipt.settledPresenceReversal.opacity, 1)
	assert(receipt.settledPresenceReversal.height > 0)
	assert.notEqual(receipt.settledPresenceReversal.display, 'none')
	assert.equal(receipt.settledPresenceReversal.ariaHidden, 'false')
	assert.equal(receipt.settledPresenceReversal.outgoing, 0)
	await emit([update({ kind: 'agent_thought_chunk', turnId: 'motion-turn-3', messageId: 'reverse-thought', blockId: 'reverse-thought', text: 'Reverse only the phase label.' })])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'thinking')
	await frames(incoming, 300, { finish: false, id: 'namzu-transcript-phase-in' })
	await frames(outgoing, 300, { finish: false, id: 'namzu-transcript-phase-out' })
	const oldGhostOpacity = await page.locator(outgoing).evaluate(node => Number(getComputedStyle(node).opacity))
	await emit([update({ kind: 'agent_thought', turnId: 'motion-turn-3', messageId: 'reverse-thought', blockId: 'reverse-thought', status: 'completed' })])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'working')
	receipt.frames.reversedPhase = await frames(incoming, 300, { finish: false, id: 'namzu-transcript-phase-in' })
	assert(Math.abs(receipt.frames.reversedPhase.values[0].opacity - oldGhostOpacity) < 0.02, 'phase reversal must continue its outgoing layer opacity')
	await expect(page.locator(outgoing)).toHaveCount(1)
	await settleFinite()
	await expect(page.locator(outgoing)).toHaveCount(0)
	receipt.checks.push('phase crossfade300ms; reveal/exit200ms height+300ms opacity; interrupted reversals preserve visible opacity and accessible status')

	await emit([{ ...update({ kind: 'turn_ended', turnId: 'motion-turn-3', stopReason: 'cancelled', reason: 'paused', result: '' }), at: at + 12000 }, state(false)])
	await settleFinite()
	receipt.settledPresenceExit = await presenceSnapshot(phase)
	assert.equal(receipt.settledPresenceExit.display, 'none')
	assert.equal(receipt.settledPresenceExit.height, 0)
	assert.equal(receipt.settledPresenceExit.ariaHidden, 'true')
	assert.equal(receipt.settledPresenceExit.inert, true)
	await expect(page.locator('[data-activity-turn="3"] .activity-trigger')).toHaveAttribute('aria-label', 'Paused · 2s')
	await expect(page.locator('.normal-transcript .notice')).toHaveText('Paused. You can continue from here.')
	await emit([prompt('Stopped fixture', at + 13000), state(true), update({ kind: 'agent_thought_chunk', turnId: 'motion-turn-4', messageId: 'stop-thought', blockId: 'stop-thought', text: 'Retained incomplete thought.' }),
		{ ...update({ kind: 'turn_ended', turnId: 'motion-turn-4', stopReason: 'cancelled', reason: 'cancelled', result: '' }), at: at + 14000 }, state(false)])
	await settleFinite()
	await expect(page.locator('[data-activity-turn="4"] .activity-trigger')).toHaveAttribute('aria-label', 'Stopped · 1s')
	await emit([prompt('Incomplete fixture', at + 15000), state(true), update({ kind: 'tool_call', toolCallId: 'failed-tool', title: 'exec', status: 'failed', view: { kind: 'terminal', command: 'Failed fixture operation', output: 'Fixture error' } }),
		{ ...update({ kind: 'turn_ended', turnId: 'motion-turn-5', stopReason: 'error', reason: 'error', result: '', error: 'Fixture execution failed' }), at: at + 17000 }, state(false)])
	await settleFinite()
	await expect(page.locator('[data-activity-turn="5"] .activity-trigger')).toHaveAttribute('aria-label', 'Work incomplete · 2s')
	await page.locator('[data-activity-turn="5"] .activity-trigger').click()
	await expect(page.locator('[data-tool-call-id="failed-tool"] .tool-status')).toHaveText('Failed')
	await page.locator('[data-activity-turn="5"] [data-slot="collapsible-panel"]').evaluateAll(panels => panels.map(panel => getComputedStyle(panel).height))
	await settleFinite()
	await page.locator('[data-tool-call-id="failed-tool"]').scrollIntoViewIfNeeded()
	receipt.screenshots.push(await capture('terminal'))
	receipt.checks.push('completed Worked for duration; Paused/Stopped middle-dot duration; error remains Work incomplete with Failed tool')

	await page.getByRole('button', { name: 'Create your first Pal', exact: true }).click()
	await page.locator('.pal-welcome').getByRole('button', { name: 'Customize your Pal', exact: true }).click()
	const customize = page.getByRole('dialog', { name: 'Customize your Pal', exact: true })
	await customize.getByRole('textbox', { name: 'Pal name', exact: true }).fill('Sıtkı')
	await customize.getByRole('button', { name: 'Save', exact: true }).click()
	await expect(customize).toHaveCount(0)
	await expect(page.locator('.pal-chat-transcript')).toBeVisible()
	await emit([prompt('Pal delivery fixture', at + 20000), state(true),
		update({ kind: 'agent_thought_chunk', turnId: 'pal-motion-turn', messageId: 'private-pal-thought', blockId: 'private-pal-thought', text: 'PRIVATE_CODING_REASONING' })], true)
	await expect(page.locator('[data-pal-chat-phase]')).toContainText('Typing…')
	await expect(page.locator('.pal-chat-transcript')).not.toContainText('PRIVATE_CODING_REASONING')
	await expect(page.locator('.normal-transcript, .turn-activity')).toHaveCount(0)
	await emit([update({ kind: 'agent_message_chunk', turnId: 'pal-motion-turn', messageId: 'pal-answer', phase: 'final_answer', text: 'PROVISIONAL_PAL_TEXT' })], true)
	await expect(page.locator('[data-pal-chat-phase]')).toContainText('Typing…')
	await expect(page.locator('.pal-chat-transcript')).not.toContainText('PROVISIONAL_PAL_TEXT')
	await emit([update({ kind: 'agent_message', turnId: 'pal-motion-turn', messageId: 'pal-answer', status: 'completed', phase: 'final_answer', content: 'Delivered Pal message.' }),
		{ ...update({ kind: 'turn_ended', turnId: 'pal-motion-turn', stopReason: 'end_turn', reason: 'end_turn', result: 'Delivered Pal message.' }), at: at + 23000 }, state(false)], true)
	await expect(page.locator('.pal-chat-message.assistant')).toContainText('Delivered Pal message.')
	await expect(page.locator('[data-pal-chat-phase]')).toHaveCount(0)
	await settleFinite()
	receipt.screenshots.push(await capture('pal'))
	receipt.checks.push('Pal retains delivered bubbles and Typing; private reasoning/provisional chunks/normal coding disclosures absent')

	await page.locator('.conversation-tab[data-tab-id="sample-thread-1"]').click()
	await expect(page.locator('.normal-transcript')).toBeVisible()
	await page.emulateMedia({ reducedMotion: 'reduce' })
	const reducedBefore = (await entryCalls()).length
	await emit([prompt('Reduced motion fixture', at + 24000), state(true), update({ kind: 'agent_thought_chunk', turnId: 'motion-turn-6', messageId: 'reduced-thought', blockId: 'reduced-thought', text: 'Reduced motion thought.' })])
	await expect(page.locator('[data-reasoning-id="6:reduced-thought"]')).toBeVisible()
	assert.equal((await entryCalls()).length, reducedBefore)
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'thinking')
	const reduced = await page.locator('.normal-transcript').evaluate(root => ({
		finiteAnimations: root.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime)).map(animation => ({ id: animation.id, duration: animation.effect?.getTiming().duration })),
		panelTransition: getComputedStyle(root.querySelector('[data-activity-turn="6"] [data-slot="collapsible-panel"]')).transitionDuration,
		outgoing: root.querySelectorAll('[data-transcript-phase-outgoing]').length,
	}))
	assert.deepEqual(reduced.finiteAnimations, [])
	assert.equal(reduced.panelTransition, '0s')
	assert.equal(reduced.outgoing, 0)
	receipt.reducedMotion = reduced
	await page.setViewportSize({ width: 720, height: 620 })
	await page.locator(phase).scrollIntoViewIfNeeded()
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
	receipt.screenshots.push(await capture('reduced-narrow'))
	receipt.checks.push('reduced motion creates no finite transcript animation and uses zero disclosure transition; narrow view has no horizontal overflow')
	await emit([{ ...update({ kind: 'turn_ended', turnId: 'motion-turn-6', stopReason: 'end_turn', reason: 'end_turn', result: '' }), at: at + 25000 }, state(false),
		prompt('Private thought fixture', at + 26000), state(true),
		update({ kind: 'agent_thought_chunk', turnId: 'motion-turn-7', messageId: 'private-thought', blockId: 'private-thought', text: '' })])
	await expect(page.locator(phase)).toHaveAttribute('data-transcript-phase', 'thinking')
	await settleFinite()
	await assertSingleLiveStatus(7, 'Thinking', { details: false })
	await expect(page.locator('[data-reasoning-id="7:private-thought"]')).toHaveCount(0)
	await page.locator(phase).scrollIntoViewIfNeeded()
	receipt.screenshots.push(await capture('private'))
	receipt.checks.push('private/redacted reasoning drives actual Thinking without an empty current-turn disclosure or invented public body')
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
	await writeFile(join(artifacts, 'transcript-single-live-status-motion-proof-20261006.json'), JSON.stringify(receipt, null, 2) + '\n')
	process.stdout.write(JSON.stringify({ passed: receipt.passed, checks: receipt.checks, error: receipt.error }) + '\n')
}
