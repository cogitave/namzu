/**
 * A turn a tool paused for a person (`ToolResult.handoff`) has nothing to
 * approve. In the interactive terminal its notice says so and one key
 * answers it: Enter continues the turn, Esc stops it. A scheduled run parked
 * the same way puts Continue / Abandon on the choice screen when the
 * operator opens it (`namzu resume <id>`).
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, ResumePausedParams } from '../agent.js'
import { PAUSED_TURN_LINES } from '../turn-interruption.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const CONVERSATION = '0ac90d46-4041-4402-8bc7-89c9a8c75f73'
const PARKED = '3b0329bb-f60a-48dc-9552-1b386c52cfe8'
const REASON = 'Sign in to example.test in the browser window'

const facts = vi.hoisted(() => ({ paused: false, scheduled: false }))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../user-commands/store.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../user-commands/store.js')>()),
	discoverUserCommands: () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => (facts.paused ? { turnId: PARKED, paused: true } : undefined),
	unansweredReviewPark: async () => undefined,
	closableProviderPause: async () => undefined,
	openSessions: async () => ({
		tenantId: 'tenant',
		projectId: '08c9b09c-4412-478c-878b-dc94927c760f',
		topicId: '4bd72c65-bcc9-475c-8d7c-27d622df04e8',
	}),
	startConversation: async () => CONVERSATION,
	loadResumableConversation: async () => [{ role: 'user', content: 'open the page', timestamp: 1 }],
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))

// The park is described rather than produced; the choice itself is the real
// one the scheduled resume puts on screen.
vi.mock('../schedule/resume.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../schedule/resume.js')>()
	const park = {
		job: { name: 'nightly-check' },
		runId: 'run-1',
		turnId: PARKED,
		model: { provider: 'openai', model: 'a-model' },
		toolCalls: [],
		handoff: { reason: REASON, detail: { origin: 'https://example.test' } },
	}
	return {
		...actual,
		findScheduledPark: async () => (facts.scheduled ? park : undefined),
		prepareScheduledResume: async (input: Parameters<typeof actual.prepareScheduledResume>[0]) => {
			if (!facts.scheduled) return undefined
			const choice = await actual.chooseHandoffContinuation(park as never, input.choose, input.say)
			if (choice === 'continue')
				return { onPermission: input.ask, rules: [], permissionMode: 'prompt' }
			if (choice === 'abandon') return { abandon: 'abandoned at a handoff' }
			return { leave: true }
		},
	}
})

const resumed: ResumePausedParams[] = []
const abandoned: string[] = []
const sent = vi.hoisted(() => ({
	handoff: false,
	sends: 0,
	browserHandoff: false,
	peeks: [] as string[],
	peekCalls: 0,
	headless: false,
	pausesAgain: false,
}))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> =>
			({
				hasProvider: true,
				sandbox: {
					unconfined: true,
					enforced: [],
					required: [],
					workspace: 'host',
				},
				compact: async () => null,
				providerSummary: 'a-provider',
				modelSummary: 'a-model',
				toolNames: () => ['bash'],
				errorHint: null,
				errorKind: null,
				agentIds: [],
				configNotices: [],
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				resumeDurable: async () => {
					throw new Error('not used by the TUI')
				},
				resumePaused: (params: ResumePausedParams) => {
					resumed.push(params)
					facts.paused = false
					if (sent.pausesAgain) facts.paused = true
					return (async function* (): AsyncIterable<AgentEvent> {
						yield sent.pausesAgain
							? ({
									kind: 'paused',
									turnId: PARKED,
									checkpointId: 'cp-2',
									reason: REASON,
									handoff: {
										kind: 'human-required',
										reason: REASON,
										detail: {
											tool: 'browser',
											cause: 'sign-in',
											origin: 'https://example.test',
										},
									},
								} as AgentEvent)
							: ({ kind: 'done' } as AgentEvent)
					})()
				},
				abandonTurn: async (turnId: string) => {
					abandoned.push(turnId)
					facts.paused = false
				},
				close: async () => {},
				setPermissionMode: async () => {},
				promptExemptTools: () => [],
				...(sent.browserHandoff
					? {
							browser: {
								status: () => ({ profile: 'default', headless: sent.headless }),
								peekSignIn: async () => {
									sent.peekCalls += 1
									return (sent.peeks.shift() ?? 'still-required') as never
								},
								release: async () => {},
							},
						}
					: {}),
				send: async function* (): AsyncIterable<AgentEvent> {
					sent.handoff = true
					sent.sends += 1
					facts.paused = true
					yield {
						kind: 'paused',
						turnId: PARKED,
						checkpointId: 'cp-1',
						reason: REASON,
						handoff: {
							kind: 'human-required',
							reason: REASON,
							...(sent.browserHandoff
								? {
										detail: {
											tool: 'browser',
											cause: 'sign-in',
											origin: 'https://example.test',
											profile: 'default',
										},
									}
								: {}),
						},
					} as AgentEvent
				},
			}) as unknown as AgentSession,
	}
})

const { App } = await import('../App.js')

const ctx = (initialConversationId?: string): TuiContext =>
	({
		cwd: process.cwd(),
		version: '0.0.0-test',
		rules: [],
		skipPermissions: false,
		...(initialConversationId ? { initialConversationId } : {}),
	}) as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	resumed.length = 0
	abandoned.length = 0
	facts.paused = false
	facts.scheduled = false
	sent.handoff = false
	sent.sends = 0
	sent.browserHandoff = false
	sent.peeks = []
	sent.peekCalls = 0
	sent.headless = false
	sent.pausesAgain = false
	vi.useRealTimers()
	for (const m of mounted.splice(0)) m.unmount()
})

// The real timer, kept before a test fakes the clock, so waiting for the screen never depends on the fake one.
const realSetTimeout = globalThis.setTimeout
const tick = (ms: number) => new Promise((r) => realSetTimeout(r, ms))

async function until(check: () => boolean, what: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (check()) return
		await tick(20)
	}
	throw new Error(`${what} did not happen within ${budgetMs}ms`)
}

async function pausedByHandoff() {
	const harness = render(<App ctx={ctx()} />)
	mounted.push(harness)
	await until(() => (harness.lastFrame() ?? '').includes('Type a message'), 'the composer')
	await tick(60)
	for (const ch of 'open the page') {
		harness.stdin.write(ch)
		await tick(5)
	}
	await tick(40)
	harness.stdin.write('\r')
	if (sent.browserHandoff) {
		// The browser's own notice: it names the window, Enter, a typed message and Esc.
		await until(
			() => (harness.lastFrame() ?? '').includes('The browser needs you'),
			'the browser handoff notice',
		)
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('The browser needs you')
		expect(frame).toContain('enter continue · or type a message · esc stop')
		return harness
	}
	await until(
		() => (harness.lastFrame() ?? '').includes('Press Enter to continue'),
		'the handoff notice',
	)
	const frame = harness.lastFrame() ?? ''
	expect(frame).toContain(`Paused. ${REASON}`)
	expect(frame).toContain('Esc to stop')
	expect(frame).toContain('enter continue · or type a message · esc stop')
	return harness
}

describe('a turn a tool paused for a person', () => {
	it('continues on Enter', async () => {
		const harness = await pausedByHandoff()
		expect(resumed).toHaveLength(0)
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.turnId).toBe(PARKED)
		expect(resumed[0]?.pendingDecision).toBeUndefined()
		// Told why it goes on now; the last result alone read as final.
		expect(resumed[0]?.systemNote).toContain(`a tool needed a person: ${REASON}`)
		expect(resumed[0]?.systemNote).toContain('that choice does not confirm the issue was resolved')
		expect(resumed[0]?.systemNote).toContain('Try the step that stopped again once')
		expect(resumed[0]?.systemNote).toContain('never type a password or a code')
		expect(abandoned).toHaveLength(0)
		await until(
			() => (harness.lastFrame() ?? '').includes(PAUSED_TURN_LINES.resuming),
			'the continuing line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
	})

	it('stops on Esc', async () => {
		const harness = await pausedByHandoff()
		harness.stdin.write('\u001b')
		await until(() => abandoned.length > 0, 'the abandoned turn')
		expect(abandoned[0]).toBe(PARKED)
		expect(resumed).toHaveLength(0)
		await until(() => !(harness.lastFrame() ?? '').includes('enter continue'), 'the hint cleared')
		await until(
			() => (harness.lastFrame() ?? '').includes('Stopped the paused reply.'),
			'the stopped line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
	})

	it('does not offer to continue a pause the person already stopped', async () => {
		const harness = await pausedByHandoff()
		harness.stdin.write('\u001b')
		await until(() => abandoned.length > 0, 'the abandoned turn')
		await until(
			() => (harness.lastFrame() ?? '').includes('Stopped the paused reply.'),
			'the stopped line',
		)
		harness.stdin.write('\r')
		await tick(200)
		expect(resumed).toHaveLength(0)
		expect(harness.lastFrame() ?? '').not.toContain('Nothing to continue here')
	})
})

const typeText = async (harness: { stdin: { write: (s: string) => void } }, text: string) => {
	for (const ch of text) {
		harness.stdin.write(ch)
		await tick(5)
	}
	await tick(40)
}

describe('a message typed while a tool has the turn paused', () => {
	it('continues the paused turn with the message as the person’s answer, once', async () => {
		const harness = await pausedByHandoff()
		expect(sent.sends).toBe(1)
		await typeText(harness, 'use my other account')
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed).toHaveLength(1)
		expect(resumed[0]?.turnId).toBe(PARKED)
		expect(resumed[0]?.systemNote).toContain('the person wrote: "use my other account"')
		expect(resumed[0]?.systemNote).toContain('never type a password or a code')
		// It did not start a second turn, and the words are on screen as theirs.
		expect(sent.sends).toBe(1)
		await until(() => (harness.lastFrame() ?? '').includes('use my other account'), 'the echo')
		await tick(60)
		expect(resumed).toHaveLength(1)
	})

	it('keeps the pause when what was typed is a slash command', async () => {
		const harness = await pausedByHandoff()
		await typeText(harness, '/zzzz')
		harness.stdin.write('\r')
		await until(
			() => (harness.lastFrame() ?? '').includes('Unknown command: /zzzz'),
			'the unknown command line',
		)
		expect(resumed).toHaveLength(0)
		expect(abandoned).toHaveLength(0)
		expect(harness.lastFrame() ?? '').toContain('enter continue · or type a message')
		// The pause still answers a key afterwards.
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.systemNote).toContain('Try the step that stopped again once')
	})

	it('stops on Esc even with a draft in the box', async () => {
		const harness = await pausedByHandoff()
		await typeText(harness, 'half a thought')
		harness.stdin.write('\u001b')
		await until(() => abandoned.length > 0, 'the abandoned turn')
		expect(abandoned[0]).toBe(PARKED)
		expect(resumed).toHaveLength(0)
	})
})

describe('Enter when the on-screen pause was lost', () => {
	it('continues the paused turn anyway, then says plainly when there is nothing left', async () => {
		const harness = await pausedByHandoff()
		// A shell line is the operator acting elsewhere: it drops the pause, the turn stays paused.
		await typeText(harness, '!true')
		harness.stdin.write('\r')
		await until(
			() => !(harness.lastFrame() ?? '').includes('enter continue · or type a message'),
			'the pause hint to go',
		)
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.turnId).toBe(PARKED)
	})

	it('prints why when no reply is paused any more', async () => {
		const harness = await pausedByHandoff()
		await typeText(harness, '!true')
		harness.stdin.write('\r')
		await until(
			() => !(harness.lastFrame() ?? '').includes('enter continue · or type a message'),
			'the pause hint to go',
		)
		facts.paused = false
		harness.stdin.write('\r')
		await until(
			() => (harness.lastFrame() ?? '').includes('Nothing to continue here: no reply is paused.'),
			'the explanation',
		)
		expect(resumed).toHaveLength(0)
	})
})

describe('a sign-in pause that notices the sign-in by itself', () => {
	// Only the timers the watch uses are faked; the rest of the terminal keeps its own.
	const SIGNIN = {
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as (
			| 'setTimeout'
			| 'clearTimeout'
			| 'setInterval'
			| 'clearInterval'
		)[],
	}

	async function pausedForSignIn() {
		sent.browserHandoff = true
		vi.useFakeTimers(SIGNIN)
		return pausedByHandoff()
	}

	it('continues once after two cleared looks, and says so quietly', async () => {
		sent.peeks = ['still-required', 'cleared', 'cleared']
		const harness = await pausedForSignIn()
		expect(resumed).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(3_000)
		expect(sent.peekCalls).toBe(1)
		expect(resumed).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(6_000)
		await until(() => resumed.length > 0, 'the automatic continue')
		expect(resumed).toHaveLength(1)
		expect(sent.peekCalls).toBe(3)
		await until(
			() => (harness.lastFrame() ?? '').includes('Looks like you signed in. Continuing.'),
			'the quiet line',
		)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(resumed).toHaveLength(1)
	})

	it('does not look at all when the browser has no window', async () => {
		sent.headless = true
		sent.peeks = ['cleared', 'cleared', 'cleared']
		const harness = await pausedForSignIn()
		expect(harness.lastFrame() ?? '').toContain('has no window')
		await vi.advanceTimersByTimeAsync(60_000)
		expect(sent.peekCalls).toBe(0)
		expect(resumed).toHaveLength(0)
	})

	it('continues at most twice by itself when the sign-in keeps stopping the turn', async () => {
		sent.pausesAgain = true
		sent.peeks = Array.from({ length: 40 }, () => 'cleared')
		await pausedForSignIn()
		// The screen redraws between looks, on the real event loop.
		for (let step = 0; step < 40; step++) {
			await vi.advanceTimersByTimeAsync(3_000)
			await new Promise<void>((done) => setImmediate(done))
		}
		expect(resumed).toHaveLength(2)
	})

	it('says so when it stops checking after its automatic continues', async () => {
		sent.pausesAgain = true
		sent.peeks = Array.from({ length: 40 }, () => 'cleared')
		const harness = await pausedForSignIn()
		for (let step = 0; step < 40; step++) {
			await vi.advanceTimersByTimeAsync(3_000)
			await new Promise<void>((done) => setImmediate(done))
		}
		await until(
			() => (harness.lastFrame() ?? '').includes('Stopped checking for your sign-in.'),
			'the line saying the watch stopped',
		)
	})

	it('looks no more once a key has answered the pause', async () => {
		sent.peeks = []
		const harness = await pausedForSignIn()
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		const looks = sent.peekCalls
		await vi.advanceTimersByTimeAsync(60_000)
		expect(sent.peekCalls).toBe(looks)
		expect(resumed).toHaveLength(1)
	})

	it('gives up after ten minutes, says it is still waiting, and keeps the pause', async () => {
		const harness = await pausedForSignIn()
		await vi.advanceTimersByTimeAsync(10 * 60_000)
		await until(
			() => (harness.lastFrame() ?? '').includes('Still waiting for you to sign in.'),
			'the waiting line',
		)
		const looks = sent.peekCalls
		await vi.advanceTimersByTimeAsync(30_000)
		expect(sent.peekCalls).toBe(looks)
		expect(resumed).toHaveLength(0)
		expect(harness.lastFrame() ?? '').toContain('enter continue')
	})
})

describe('namzu resume <id> of a scheduled run a tool paused for a person', () => {
	async function opened() {
		facts.paused = true
		facts.scheduled = true
		const harness = render(<App ctx={ctx(CONVERSATION)} />)
		mounted.push(harness)
		await until(
			() => (harness.lastFrame() ?? '').includes('Continue the scheduled run?'),
			'the Continue / Abandon choice',
		)
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('Continue')
		expect(frame).toContain('Abandon')
		expect(frame).toContain('needs you: Sign in to example.test')
		expect(resumed).toHaveLength(0)
		return harness
	}

	it('continues the run on Continue', async () => {
		const harness = await opened()
		harness.stdin.write('1')
		await tick(40)
		harness.stdin.write('\r')
		await until(() => resumed.length > 0, 'the resumed turn')
		expect(resumed[0]?.turnId).toBe(PARKED)
		expect(resumed[0]?.permissionMode).toBe('prompt')
		expect(abandoned).toHaveLength(0)
		await until(
			() => (harness.lastFrame() ?? '').includes(PAUSED_TURN_LINES.resuming),
			'the continuing line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
	})

	it('abandons the run on Abandon', async () => {
		const harness = await opened()
		harness.stdin.write('2')
		await tick(40)
		harness.stdin.write('\r')
		await until(() => abandoned.length > 0, 'the abandoned turn')
		expect(abandoned[0]).toBe(PARKED)
		expect(resumed).toHaveLength(0)
		await until(
			() => (harness.lastFrame() ?? '').includes(PAUSED_TURN_LINES.abandonedScheduled),
			'the stopped line',
		)
		expect(harness.lastFrame() ?? '').not.toContain(PARKED)
		expect(harness.lastFrame() ?? '').not.toContain(PAUSED_TURN_LINES.resuming)
	})
})
