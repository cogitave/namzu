/**
 * A reply that paused for a lost connection tries again by itself. The pieces
 * (the schedule, the timer, the pause wording) have their own tests; this
 * drives the rendered App to show that they meet: the timer is armed by a
 * pause that mends itself, Enter and a new message end the run of tries, a try
 * that could not start is followed by the next step of the schedule, and a
 * busy screen holds the try back. The clock is faked and only the test turns
 * it.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent } from '../agent.js'
import { AUTO_RESUME_DELAYS_MS } from '../pause-auto-resume.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const TURN = '3b0329bb-f60a-48dc-9552-1b386c52cfe8'

const pausedByNetwork = (): AgentEvent =>
	({
		kind: 'paused',
		turnId: TURN,
		checkpointId: '01a12552-fe6b-733f-bdfd-ee9abb0b6021',
		reason: 'fetch failed',
		explanation: { id: 'provider.network', message: 'x', hint: 'y' },
		providerError: { kind: 'network', providerId: 'openai', providerCode: 'ECONNRESET' },
	}) as unknown as AgentEvent

const facts = vi.hoisted(() => ({
	/** Whether the store still holds the paused turn. */
	active: true,
	lookups: 0,
	sends: 0,
	resumes: 0,
	/** What each continued reply does, in order; the last one repeats. */
	outcomes: [] as Array<'paused' | 'done'>,
	/** Holds the first send open when set, so the screen stays busy. */
	hold: undefined as Promise<void> | undefined,
}))

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => {
		facts.lookups += 1
		return facts.active ? { turnId: TURN, paused: false } : undefined
	},
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async () =>
			fakeAgentSession({
				resumePaused: () => {
					facts.resumes += 1
					const outcome = facts.outcomes[Math.min(facts.resumes, facts.outcomes.length) - 1]
					return (async function* (): AsyncIterable<AgentEvent> {
						yield outcome === 'paused'
							? pausedByNetwork()
							: ({ kind: 'done', stopReason: 'end_turn' } as AgentEvent)
					})()
				},
				send: async function* (): AsyncIterable<AgentEvent> {
					facts.sends += 1
					if (facts.sends === 1) {
						yield pausedByNetwork()
						if (facts.hold) await facts.hold
						return
					}
					yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
				},
			}),
	}
})

const { App } = await import('../App.js')

const mounted: { unmount: () => void }[] = []
const [FIRST, SECOND] = AUTO_RESUME_DELAYS_MS as readonly [number, number]

beforeEach(() => {
	facts.active = true
	facts.lookups = 0
	facts.sends = 0
	facts.resumes = 0
	facts.outcomes = ['done']
	facts.hold = undefined
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
	})
})
afterEach(() => {
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.useRealTimers()
})

/** Look again after each turn of the event loop (setImmediate is not faked). */
async function until(read: () => boolean, why: string): Promise<void> {
	for (let turn = 0; turn < 2_000; turn++) {
		if (read()) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	expect(read(), why + ' ' + lastShown()).toBe(true)
}

let lastShown = () => ''
const flat = (frame: string | undefined) => (frame ?? '').replace(/\s+/g, ' ')

/** Mount, send one message and wait for the pause that mends itself. */
async function mountPaused() {
	const harness = render(<App ctx={{ cwd: '/w', version: '0.0.0-test' }} />)
	mounted.push(harness)
	lastShown = () => flat(harness.lastFrame())
	await until(() => flat(harness.lastFrame()).includes('Type a message'), 'no composer')
	harness.stdin.write('go')
	await vi.advanceTimersByTimeAsync(40)
	harness.stdin.write('\r')
	await until(() => flat(harness.lastFrame()).includes('trying again in'), 'no countdown')
	return harness
}

describe('a pause that mends itself', () => {
	it('tries again when the first wait is over, and not before', async () => {
		const harness = await mountPaused()
		expect(flat(harness.lastFrame())).toContain('enter try now · esc stop')
		await vi.advanceTimersByTimeAsync(FIRST - 1_000)
		expect(facts.resumes).toBe(0)
		await vi.advanceTimersByTimeAsync(1_000 + 1_100)
		await until(() => facts.resumes === 1, 'never tried again')
	})

	it('waits the next step after a try that paused again', async () => {
		facts.outcomes = ['paused', 'done']
		const harness = await mountPaused()
		await vi.advanceTimersByTimeAsync(FIRST + 1_100)
		await until(() => facts.resumes === 1, 'first try missing')
		await until(() => /trying again in (29|30)s/.test(flat(harness.lastFrame())), 'no 30s wait')
		await vi.advanceTimersByTimeAsync(SECOND - 2_000)
		expect(facts.resumes).toBe(1)
		await vi.advanceTimersByTimeAsync(2_000 + 1_100)
		await until(() => facts.resumes === 2, 'second try missing')
	})

	it('goes back to the first step after Enter', async () => {
		facts.outcomes = ['paused', 'paused', 'done']
		const harness = await mountPaused()
		await vi.advanceTimersByTimeAsync(FIRST + 1_100)
		await until(() => facts.resumes === 1, 'first try missing')
		// The second pause waits the second step; Enter does not wait for it.
		await until(() => /trying again in (29|30)s/.test(flat(harness.lastFrame())), 'no 30s wait')
		harness.stdin.write('\r')
		await until(() => facts.resumes === 2, 'Enter did not try at once')
		await until(() => /trying again in (14|15)s/.test(flat(harness.lastFrame())), 'no 15s wait')
		// The run of tries began again, so the wait is the first step, not the third.
		await vi.advanceTimersByTimeAsync(FIRST + 1_100)
		await until(() => facts.resumes === 3, 'the wait did not start over')
	})

	it('stops when a new message is sent', async () => {
		const harness = await mountPaused()
		harness.stdin.write('next')
		await vi.advanceTimersByTimeAsync(40)
		harness.stdin.write('\r')
		await until(() => facts.sends === 2, 'the new message was not sent')
		await vi.advanceTimersByTimeAsync(20 * 60_000)
		expect(facts.resumes).toBe(0)
		expect(flat(harness.lastFrame())).not.toContain('trying again in')
	})

	it('stops when another conversation is started', async () => {
		const harness = await mountPaused()
		harness.stdin.write('/new')
		await vi.advanceTimersByTimeAsync(40)
		harness.stdin.write('\r')
		await vi.advanceTimersByTimeAsync(40)
		await vi.advanceTimersByTimeAsync(20 * 60_000)
		expect(facts.resumes).toBe(0)
		expect(flat(harness.lastFrame())).not.toContain('trying again in')
	})

	it('keeps a timer running when a try could not start', async () => {
		// The store holds no paused turn, so the try returns without starting.
		facts.active = false
		await mountPaused()
		await vi.advanceTimersByTimeAsync(FIRST + 1_100)
		await until(() => facts.lookups >= 1, 'no first try')
		const afterFirst = facts.lookups
		expect(facts.resumes).toBe(0)
		// The next step of the schedule is armed, not nothing.
		await vi.advanceTimersByTimeAsync(SECOND - 2_000)
		expect(facts.lookups).toBe(afterFirst)
		await vi.advanceTimersByTimeAsync(2_000 + 1_100)
		await until(() => facts.lookups > afterFirst, 'no second try')
		// And once the turn is there to continue, a later try takes it.
		facts.active = true
		await vi.advanceTimersByTimeAsync(AUTO_RESUME_DELAYS_MS[2] ?? 0)
		await vi.advanceTimersByTimeAsync(2_000)
		await until(() => facts.resumes === 1, 'a later try never took')
	})

	it('holds the try back while the screen is busy and goes on once it is free', async () => {
		let release: () => void = () => {}
		facts.hold = new Promise<void>((resolve) => {
			release = resolve
		})
		const harness = render(<App ctx={{ cwd: '/w', version: '0.0.0-test' }} />)
		mounted.push(harness)
		lastShown = () => flat(harness.lastFrame())
		await until(() => flat(harness.lastFrame()).includes('Type a message'), 'no composer')
		harness.stdin.write('go')
		await vi.advanceTimersByTimeAsync(40)
		harness.stdin.write('\r')
		await until(() => facts.sends === 1, 'not sent')
		// The reply paused but is still wrapping up: the screen is not idle.
		await vi.advanceTimersByTimeAsync(FIRST + 5_000)
		expect(facts.resumes).toBe(0)
		expect(facts.lookups).toBe(0)
		release()
		await vi.advanceTimersByTimeAsync(2_000)
		await until(() => facts.resumes === 1, 'did not go on once free')
	})
})
