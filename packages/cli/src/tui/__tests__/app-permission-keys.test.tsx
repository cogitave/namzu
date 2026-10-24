/**
 * What decides an open permission prompt — asserted against a rendered `<App>`.
 *
 * This is the first harness that mounts the root component. Everything in
 * `App.tsx`'s key handler was previously unreachable from a test: both existing
 * Ink harnesses render `<Picker>`, so the Ctrl+C ladder, the Esc-interrupt and
 * this prompt had no coverage at all. That gap is why a key advertised as
 * expanding tool output shipped able to do nothing, and why Enter could approve
 * a tool call while being named on no screen.
 *
 * The scenario is the real one rather than a convenient one: a turn is running,
 * the operator is typing a follow-up into the composer (which stays live while
 * the agent works, and which the docs encourage using that way), and the agent
 * asks to run a tool. The overlay takes the screen under their hands.
 *
 * Not a terminal. This drives Ink's own stdin and reads Ink's own frames, so it
 * proves which handler ran and what it decided. Real key repeat, real paste
 * timing, terminal-specific escape sequences and how any of this FEELS at human
 * speed are outside what a harness can establish.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { cancelCauseOf, generateSessionId } from '@namzu/sdk'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, PermissionDecision, PermissionRequest } from '../agent.js'
import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Decisions the fake session was given, in order. */
const decisions: PermissionDecision[] = []

/** What the fake session was told to remember, in order. */
const remembered: unknown[] = []

/** Per-turn modes and executions observed beyond the App boundary. */
const permissionModes: unknown[] = []
const turnSignals: Array<AbortSignal | undefined> = []
const firstReviewSession = generateSessionId()
const secondReviewSession = generateSessionId()
let parallelApprovals = false
let toolExecutions = 0
let requestedToolCalls: PermissionRequest['toolCalls'] = [
	{
		id: 'call-1',
		name: 'bash',
		input: { command: 'rm -rf build' },
		isDestructive: true,
	},
]
let holdAfterPermissionDecision = false
let finishTurnAfterDecision = false
let releasePermissionHandoff: () => void = () => {}
let permissionHandoff = Promise.resolve()

/**
 * The clock the settle window is measured against, driven by the test.
 *
 * `Date.now` is stubbed rather than waited on. The window is 350ms of REAL
 * time, and an earlier version of this file simply raced it — writing the key
 * quickly and trusting the harness to get there first. That made the result a
 * function of how loaded the machine was: the suite transforms TypeScript on
 * the way in, and a slow run drifted past 350ms and flipped a passing
 * assertion to a failing one with nothing about the code changed. The repo has
 * met this cliff before; `vitest.config.ts` is entirely about the last time.
 *
 * Stubbing the clock makes "before the window" and "after the window" exact.
 * Real timers still drive Ink's own rendering, because `setTimeout` does not
 * consult `Date.now` — so only the quantity under test becomes deterministic.
 */
let nowMs = 1_000_000
let permissionDelayMs = 30

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))

vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))

vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => {
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'a-provider',
				modelSummary: 'a-model',
				toolNames: () => ['bash'],
				presenter: genericPresenter,
				errorHint: null,
				errorKind: null,
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				agentIds: [],
				configNotices: [],
				// The TUI never resumes a durable turn; a stub that answered would
				// make a resume look reachable from here.
				resumeDurable: async () => {
					throw new Error('not used by the TUI')
				},
				resumePaused: () => {
					throw new Error('resumePaused is not part of this test')
				},
				close: async () => {},
				allowForSession: (allows) => {
					remembered.push(allows)
					return undefined
				},
				commandArguments: new Map([['bash', 'command']]),
				// A representative exempt roster: one declared read-only, one
				// named override. Enough for the readout assertions below.
				promptExemptTools: () => ['glob', 'read', 'task_create'],
				// Streams one delta so the composer is live and a draft can be
				// typed, then asks for permission and parks on the answer — which
				// is exactly the moment this file is about. A second batch is
				// never requested, because approve-all is asserted through
				// `/permissions` rather than through a second prompt.
				send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
					permissionModes.push(opts?.permissionMode)
					turnSignals.push(opts?.signal)
					yield { kind: 'delta', text: 'working' } as AgentEvent
					await new Promise((r) => setTimeout(r, permissionDelayMs))
					if (opts?.permissionMode === 'auto') {
						toolExecutions += 1
						return
					}
					if (opts?.permissionMode === 'strict') return
					// The session the review came from: a child's, so the prompt names it.
					const req = {
						toolCalls: requestedToolCalls,
						sessionId: firstReviewSession,
					} as PermissionRequest
					if (parallelApprovals) {
						await Promise.all(
							[
								req,
								{
									sessionId: secondReviewSession,
									toolCalls: [
										{
											id: 'call-2',
											name: 'bash',
											isDestructive: false,
											input: { command: 'echo second-review' },
										},
									],
								} as PermissionRequest,
							].map(async (request) => {
								const decision = await opts?.onPermission?.(request)
								if (decision) decisions.push(decision)
							}),
						)
						return
					}
					const decision = await opts?.onPermission?.(req)
					if (decision) {
						decisions.push(decision)
						if (decision.kind === 'approve') toolExecutions += 1
						if (holdAfterPermissionDecision) await permissionHandoff
					}
					if (finishTurnAfterDecision) yield { kind: 'done' } as AgentEvent
				},
			}
		},
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: process.cwd(), version: '0.0.0-test' }

const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait until a decision lands, or give up after `timeoutMs`.
 *
 * Polling rather than one fixed sleep, because the two are not
 * interchangeable here. A bare `\x1B` is the prefix of every arrow and function
 * key, so an input parser holds it briefly to see whether more follows, and
 * under a loaded parallel run that hold stretches. A fixed 60ms wait passed
 * this file alone and failed inside the full suite — the same load cliff
 * `vitest.config.ts` documents, arrived at from a different direction.
 *
 * Absence cannot be polled for, so the tests asserting that NOTHING was decided
 * still wait a fixed, generous interval. That asymmetry is inherent: proving a
 * decision happened only needs enough time, proving one did not needs all of it.
 */
async function decisionSettles(timeoutMs?: number): Promise<void> {
	await vi.waitFor(
		() => expect(decisions.length, 'no decision arrived').toBeGreaterThan(0),
		timeoutMs,
	)
}

/**
 * Render, reach a running turn, type a draft, and stop with the prompt open.
 *
 * Returns once the overlay is on screen — every assertion below starts here, so
 * the setup is shared rather than restated with slightly different waits.
 */
async function promptOpenWithDraftInFlight() {
	const harness = render(<App ctx={ctx} />)
	// Registered for teardown BEFORE the first assertion below, so an assertion
	// that throws still gets torn down. Unmounting at the end of each test
	// instead looks tidier and is a trap: the first failure then leaks a live
	// Ink instance into the next test, and every following test fails with "the
	// prompt never opened" — four misleading failures stacked on one real one.
	// Found while mutation-checking this file, where exactly that happened.
	mounted.push(harness)
	// Probe → session → ready.
	await tick(60)
	// Start a turn. The keys go in separately on purpose: Ink delivers one
	// `stdin.write` as ONE keypress, so `'go\r'` arrives as a single event whose
	// `input` is the whole string and whose `key.return` is false — the
	// composer takes it as pasted text and nothing is ever submitted. A test
	// that batched them would sit there asserting against a turn that never ran.
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	await tick(40)
	// The follow-up the operator is part-way through typing while it runs.
	harness.stdin.write('and then deploy')
	// Poll rather than sleep a fixed interval. The mock parks 30ms before
	// asking, but under the full parallel run the transform cost pushes every
	// step out, and a fixed wait here made the whole file fail intermittently
	// with "the prompt never opened" — a flake in the setup, reported as a
	// failure of whatever the test was actually about.
	await vi.waitFor(() =>
		expect(harness.lastFrame(), 'the prompt never opened').toContain('enter confirm'),
	)
	return harness
}

/** Harnesses to tear down, whatever the test did. */
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	decisions.length = 0
	remembered.length = 0
	permissionModes.length = 0
	turnSignals.length = 0
	parallelApprovals = false
	toolExecutions = 0
	requestedToolCalls = [
		{
			id: 'call-1',
			name: 'bash',
			input: { command: 'rm -rf build' },
			isDestructive: true,
		},
	]
	holdAfterPermissionDecision = false
	finishTurnAfterDecision = false
	permissionHandoff = new Promise<void>((resolve) => {
		releasePermissionHandoff = resolve
	})
	permissionDelayMs = 30
	nowMs = 1_000_000
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
	releasePermissionHandoff()
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

/** Move the stubbed clock past the settle window. */
function settle(): void {
	nowMs += APPROVAL_SETTLE_MS + 1
}

describe('the permission prompt', () => {
	it('confirms the highlighted answer on Enter, but only once the prompt has settled', async () => {
		// Enter is the key that submits the draft the operator was typing, and
		// it is in flight exactly when the overlay appears — so an Enter inside
		// the settle window decides nothing. Past the window it confirms the
		// answer the cursor is on, which opens on "Yes"; the owner chose the
		// prompt an operator already knows from other coding agents over a
		// prompt Enter cannot answer.
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()

		stdin.write('\r')
		await tick(50)
		expect(decisions, 'an in-flight Enter decided the prompt').toEqual([])
		expect(lastFrame()).toContain('enter confirm')

		settle()
		stdin.write('\r')
		await tick(400)
		expect(decisions).toEqual([{ kind: 'approve' }])
	})

	it('moves the cursor with the arrows and confirms the answer it lands on', async () => {
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		expect(lastFrame()).toContain('❯ 1. Yes')

		stdin.write('\x1b[B')
		await tick(50)
		expect(lastFrame()).toContain('❯ 2. No, and tell Namzu what to do differently')

		settle()
		stdin.write('\r')
		await tick(400)
		expect(decisions).toEqual([{ kind: 'reject', declined: {} }])
	})

	it('answers by number once the prompt has settled', async () => {
		const { stdin } = await promptOpenWithDraftInFlight()
		settle()
		stdin.write('2')
		await tick(400)
		expect(decisions).toEqual([{ kind: 'reject', declined: {} }])
	})

	it('ignores an approving key that arrives before the prompt can have been read', async () => {
		// `y` is an ordinary letter. Someone mid-word when the overlay mounts is
		// one keystroke from approving a call they have not seen.
		const { stdin } = await promptOpenWithDraftInFlight()

		stdin.write('y')
		await tick(400)

		expect(decisions, 'an immediate y approved').toEqual([])
	})

	it('approves on y once the prompt has been up long enough to read', async () => {
		// The other half: the guard must not make the advertised key inert. A
		// deferred approval that never arrives is its own defect.
		const { stdin } = await promptOpenWithDraftInFlight()

		settle()
		stdin.write('y')
		await decisionSettles()

		expect(decisions).toEqual([{ kind: 'approve' }])
	})

	it('shows Working during the hand-off instead of retaining a dead approval footer', async () => {
		holdAfterPermissionDecision = true
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()

		settle()
		stdin.write('y')
		await decisionSettles()
		await tick(100)

		const frame = lastFrame() ?? ''
		expect(frame).toContain('Working')
		expect(frame).not.toContain('enter confirm')
		expect(frame).not.toContain('y approve')
	})

	it('runs the four-agent approval path as named work and hands it to Working', async () => {
		requestedToolCalls = ['API research', 'Security review', 'UX critique', 'Delivery plan'].map(
			(description, index) => ({
				id: `agent-call-${index}`,
				name: 'Agent',
				input: {
					description,
					prompt: `Complete ${description.toLowerCase()} and report evidence.`,
					role: 'Focused reviewer',
					workflow: 'Product review',
					phase: 'Research',
					phase_order: 0,
				},
				isDestructive: false,
			}),
		)
		holdAfterPermissionDecision = true
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		const approval = lastFrame() ?? ''

		expect(approval).toContain('Start 4 agents')
		expect(approval).toContain('1. API research · files + commands')
		expect(approval).toContain('4. Delivery plan · files + commands')
		expect(approval).toContain('❯ 1. Start these 4 agents')
		expect(approval).toContain('2. Do not start')
		expect(approval).not.toContain('"calls"')
		expect(approval).not.toContain('agent-call-0')

		settle()
		stdin.write('y')
		await decisionSettles()
		await tick(100)
		expect(decisions).toEqual([{ kind: 'approve' }])

		const working = lastFrame() ?? ''
		expect(working).toContain('Working')
		expect(working).not.toContain('Do you want to start')
		expect(working).not.toContain('y approve')
	})

	it('rejects on esc immediately, without waiting out the guard', async () => {
		// Refusal is not deferred: it is the recoverable direction, and a reject
		// key that ignored the first press would read as a frozen prompt.
		const { stdin } = await promptOpenWithDraftInFlight()

		stdin.write('\x1B')
		await decisionSettles()

		expect(decisions).toEqual([{ kind: 'reject', declined: {} }])
	})

	it('names every key that decides it, and no key that does not', async () => {
		const { lastFrame } = await promptOpenWithDraftInFlight()
		const frame = lastFrame() ?? ''

		// Asserted as whole phrases the OVERLAY produces, not as bare letters.
		// The previous version of this test used `toContain('y')`, which is
		// satisfied by any frame containing the letter y — including every frame
		// this component has ever rendered — and `toContain('reject')`, which the
		// status bar's own hint satisfies from the other side of the screen. Two
		// assertions that could not fail, guarding the advertisement that four
		// separate fixes tonight were about.
		expect(frame).not.toContain('allow all tools')
		expect(frame).toContain('tell Namzu what to do differently')
		// The advertisement is the contract the handler is held to: Enter
		// confirms the highlighted answer, and the box says so.
		expect(frame.toLowerCase()).toContain('enter confirm')
	})

	it('names the key that stops the turn, and says that it is different', async () => {
		// `n`/`esc` decline this batch and the agent carries on trying something
		// else; `ctrl+c` declines AND ends the turn. Two outcomes, and only the
		// first was on the screen — so an operator who wanted namzu to stop
		// pressed `n`, watched it continue, and had no way to learn otherwise
		// from the box they were reading. The distinction was written down only
		// nowhere else.
		const { lastFrame } = await promptOpenWithDraftInFlight()
		const frame = lastFrame() ?? ''

		expect(frame.toLowerCase(), 'the key that stops the turn is unnamed').toContain('ctrl+c')
		expect(frame, 'named the key without naming what makes it different').toContain('ctrl+c stop')
	})

	it('labels the d key as view input', async () => {
		const { lastFrame } = await promptOpenWithDraftInFlight()
		expect(lastFrame() ?? '').toContain('d view input')
	})

	it('toggles the immutable exact envelope without deciding the prompt', async () => {
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		expect(lastFrame()).toContain('Bash command')
		expect(lastFrame()).not.toContain('"calls"')

		stdin.write('d')
		await tick(100)
		expect(lastFrame()).toContain('Exact prepared input')
		expect(lastFrame()).toContain('"calls"')
		expect(decisions).toEqual([])

		stdin.write('d')
		await tick(100)
		expect(lastFrame()).toContain('Bash command')
		expect(decisions).toEqual([])
	})

	it('opens an evolved shape exact-first and keeps its hidden suffix reachable', async () => {
		requestedToolCalls = [
			{
				id: 'call-1',
				name: 'bash',
				input: {
					command: 'echo safe',
					futureOption: 'x'.repeat(1_200),
					exactSuffix: 'EVOLVED_SUFFIX_REACHABLE',
				},
				isDestructive: true,
			},
		]
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		expect(lastFrame()).toContain('Exact prepared input')
		expect(lastFrame()).toContain('"calls"')

		stdin.write('d')
		await tick(100)
		expect(lastFrame()).toContain('Bash command')
		expect(decisions).toEqual([])
		stdin.write('d')
		await tick(100)
		expect(lastFrame()).toContain('Exact prepared input')

		for (
			let page = 0;
			page < 30 && !(lastFrame() ?? '').includes('EVOLVED_SUFFIX_REACHABLE');
			page += 1
		) {
			stdin.write('\x1b[6~')
			await tick(30)
		}
		expect(lastFrame()).toContain('EVOLVED_SUFFIX_REACHABLE')
		expect(decisions, 'view/paging keys decided consent').toEqual([])
	})

	it('ctrl+c does what the overlay now says it does', async () => {
		// The other half, and the reason the line above is allowed to claim it:
		// an advertisement is only worth adding if the key behaves that way. The
		// batch is declined AND the turn is aborted, where `n` declines only.
		const { stdin } = await promptOpenWithDraftInFlight()

		stdin.write('\x03')
		await decisionSettles()

		expect(decisions).toEqual([{ kind: 'reject', feedback: 'User interrupted.' }])
		expect(cancelCauseOf(turnSignals[0]?.reason)).toBe('user')
	})
})

describe('the answers beyond yes and no', () => {
	it('has no key that approves every tool: a is not an answer', async () => {
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		settle()
		stdin.write('a')
		await tick(200)
		expect(decisions).toEqual([])
		expect(lastFrame()).toContain('enter confirm')
		expect(lastFrame()).not.toContain('bypass permissions on')
	})

	it('switches an edit prompt to accept edits through the mode path, and says so in the footer', async () => {
		requestedToolCalls = [
			{
				id: 'call-1',
				name: 'edit',
				input: { path: 'a.txt', old_string: 'a', new_string: 'b' },
				isDestructive: false,
			},
		]
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		expect(lastFrame()).toContain('2. Yes, and switch to accept edits for this session')

		settle()
		stdin.write('2')
		await decisionSettles()
		expect(decisions).toEqual([{ kind: 'approve' }])
		await tick(150)
		expect(lastFrame()).toContain('accept edits on')
		expect(remembered).toEqual([])
	})

	it('remembers a command by its two-word prefix when asked to', async () => {
		requestedToolCalls = [
			{ id: 'call-1', name: 'bash', input: { command: 'npm test' }, isDestructive: false },
		]
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		expect(lastFrame()).toMatch(/2\. Yes, and don't ask again for npm test \* commands in /)

		settle()
		stdin.write('2')
		await decisionSettles()
		expect(decisions).toEqual([{ kind: 'approve' }])
		expect(remembered).toEqual([[{ kind: 'prefix', tool: 'bash', prefix: 'npm test' }]])
	})

	it('does not settle a queued request on an answer given to another prompt', async () => {
		parallelApprovals = true
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		settle()
		stdin.write('y')
		await tick(100)
		expect(decisions).toEqual([{ kind: 'approve' }])
		expect(lastFrame()).toContain('enter confirm')
	})
})

describe('/permissions session mode', () => {
	// It used to be refused ("Permissions were not changed. Finish or stop the
	// current work first."). A mode change applies at
	// once, mid-turn; the running turn reads the mode at each decision, so the
	// change governs its next call, and the turn itself was still sent under
	// the mode current when it began.
	it('changes the mode while a turn runs, without resending the turn under it', async () => {
		permissionDelayMs = 250
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		const { stdin, lastFrame } = harness
		await tick(160)

		stdin.write('first turn')
		await tick(20)
		stdin.write('\r')
		await tick(10)
		stdin.write('/permissions strict')
		await tick(20)
		stdin.write('\r')
		await tick(120)

		expect(lastFrame()).not.toContain('Permissions were not changed')
		expect(lastFrame(), 'a change asked for by name gets a reply').toContain(
			'Permissions: Preapproved tools only for this conversation.',
		)
		expect(permissionModes).toEqual(['prompt'])
	})

	it('restores prompting after a --yolo launch before any tool can run', async () => {
		const harness = render(<App ctx={{ ...ctx, skipPermissions: true }} />)
		mounted.push(harness)
		const { stdin, lastFrame } = harness
		await tick(160)

		stdin.write('/permissions prompt')
		await tick(60)
		stdin.write('\r')
		await tick(160)
		expect(lastFrame()).toContain('Permissions: Ask before changes for this conversation.')

		stdin.write('change the file')
		await tick(60)
		stdin.write('\r')
		await vi.waitFor(() => expect(lastFrame() ?? '').toContain('enter confirm'))

		expect(permissionModes).toEqual(['prompt'])
		expect(toolExecutions, 'the yolo launch still auto-approved after switching to prompt').toBe(0)
		expect(lastFrame(), 'the destructive tool never reached a prompt').toContain('enter confirm')

		settle()
		stdin.write('y')
		await decisionSettles()
		expect(toolExecutions).toBe(1)

		await tick(120)
		stdin.write('/permissions')
		await tick(60)
		stdin.write('\r')
		await tick(160)
		const frame = lastFrame() ?? ''
		expect(frame).toContain('More options')
		expect(frame).toContain('Ask before changes and shell commands.')
		expect(frame).toMatch(/Ask before changes\s+\[current\]/)
		expect(frame).not.toContain('approved automatically (--dangerously-skip-permissions)')
	})
})

describe('concurrent permission requests', () => {
	it('keeps each request separate and resets the consent window', async () => {
		parallelApprovals = true
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		expect(lastFrame()).toContain('1 more awaiting approval')
		expect(lastFrame()).toContain('Agent: another agent')
		expect(lastFrame()).not.toContain(secondReviewSession)
		expect(lastFrame()).not.toContain('echo second-review')
		settle()
		stdin.write('y')
		await decisionSettles()
		await tick(60)
		expect(decisions).toEqual([{ kind: 'approve' }])
		expect(lastFrame()).toContain('echo second-review')
		expect(lastFrame()).toContain('Agent: another agent')
		expect(lastFrame()).not.toContain(firstReviewSession)
		stdin.write('\r')
		await tick(60)
		expect(decisions).toHaveLength(1)
		stdin.write('n')
		await tick(100)
		expect(decisions).toEqual([{ kind: 'approve' }, { kind: 'reject', declined: {} }])
	})
	it('rejects all waiting requests and aborts the turn on Ctrl+C', async () => {
		parallelApprovals = true
		const { stdin } = await promptOpenWithDraftInFlight()
		stdin.write('\x03')
		await tick(100)
		expect(decisions).toHaveLength(2)
		expect(decisions.every((decision) => decision.kind === 'reject')).toBe(true)
		expect(turnSignals[0]?.aborted).toBe(true)
	})
	it('settles every pending request when the application unmounts', async () => {
		parallelApprovals = true
		const harness = await promptOpenWithDraftInFlight()
		harness.unmount()
		mounted.length = 0
		await tick(60)
		expect(decisions).toHaveLength(2)
		expect(decisions.every((decision) => decision.kind === 'reject')).toBe(true)
	})
})

describe('the closing "Worked for" line', () => {
	it('leaves the time spent on an approval out of the figure', async () => {
		holdAfterPermissionDecision = true
		finishTurnAfterDecision = true
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()
		// The frame shows the prompt a beat before the effect that starts the
		// wait clock has run; let it run before the stubbed clock moves.
		await tick(20)

		// The person takes a minute to answer. The agent was not working then.
		nowMs += 60_000
		settle()
		stdin.write('\r')
		await decisionSettles()
		// Five seconds of real work after the answer, then the turn ends.
		nowMs += 5_000
		releasePermissionHandoff()

		await vi.waitFor(() => expect(lastFrame() ?? '').toContain('Worked for'))
		const frame = lastFrame() ?? ''
		expect(frame).toMatch(/Worked for [5-6]s/u)
		expect(frame, 'the minute spent waiting counted as work').not.toMatch(/Worked for 1m/u)
	})
})
