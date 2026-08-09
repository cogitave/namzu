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

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, PermissionDecision, PermissionRequest } from '../agent.js'
import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Decisions the fake session was given, in order. */
const decisions: PermissionDecision[] = []

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

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
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
			// Stands in for the `approval` object the real session closes over
			// (`agent.ts`), which `makeResumeHandler` flips on approve-all and
			// which `approvalLatched` reads. Emulated rather than imported
			// because this mock replaces the handler that owns it; that the real
			// handler sets the flag is pinned separately in `agent.test.ts`.
			let latched = false
			return {
				hasProvider: true,
				providerSummary: 'a-provider',
				modelSummary: 'a-model',
				toolNames: () => ['bash'],
				errorHint: null,
				errorKind: null,
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				agentIds: [],
				configNotices: [],
				close: async () => {},
				approvalLatched: () => latched,
				// A representative exempt roster: one declared read-only, one
				// named override. Enough for the readout assertions below.
				promptExemptTools: () => ['glob', 'read', 'task_create'],
				// Streams one delta so the composer is live and a draft can be
				// typed, then asks for permission and parks on the answer — which
				// is exactly the moment this file is about. A second batch is
				// never requested, because approve-all is asserted through
				// `/permissions` rather than through a second prompt.
				send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
					yield { kind: 'delta', text: 'working' } as AgentEvent
					await new Promise((r) => setTimeout(r, 30))
					const req: PermissionRequest = {
						toolCalls: [
							{ id: 'call-1', name: 'bash', summary: 'rm -rf build', isDestructive: true },
						],
					}
					const decision = await opts?.onPermission?.(req)
					if (decision) {
						decisions.push(decision)
						if (decision.kind === 'approve-all') latched = true
					}
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
async function decisionSettles(timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (decisions.length === 0 && performance.now() - started < timeoutMs) {
		await tick(20)
	}
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
	const started = performance.now()
	while (!(harness.lastFrame() ?? '').includes('wants to run') && performance.now() - started < 3_000) {
		await tick(20)
	}
	expect(harness.lastFrame(), 'the prompt never opened').toContain('wants to run')
	return harness
}

/** Harnesses to tear down, whatever the test did. */
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	decisions.length = 0
	nowMs = 1_000_000
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

/** Move the stubbed clock past the settle window. */
function settle(): void {
	nowMs += APPROVAL_SETTLE_MS + 1
}

describe('the permission prompt', () => {
	it('does not approve on Enter, even once the prompt has settled', async () => {
		// The heart of it. Enter is the key that submits the draft the operator
		// was typing, it is in flight exactly when the overlay appears, and it is
		// named on no screen — so it must decide nothing here.
		//
		// The wait is what gives this test its teeth. Pressing Enter immediately
		// proves nothing: the settle window would swallow it whether or not the
		// approving branch still read `key.return`, and an earlier draft of this
		// test passed with the defect restored for exactly that reason. Waiting
		// past the window leaves the binding as the only thing that can decide
		// it — `y` at this same moment approves, one test down.
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()

		settle()
		stdin.write('\r')
		await tick(400)

		expect(decisions, 'Enter decided the prompt').toEqual([])
		expect(lastFrame(), 'the prompt closed without a decision').toContain('wants to run')
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

	it('rejects on esc immediately, without waiting out the guard', async () => {
		// Refusal is not deferred: it is the recoverable direction, and a reject
		// key that ignored the first press would read as a frozen prompt.
		const { stdin } = await promptOpenWithDraftInFlight()

		stdin.write('\x1B')
		await decisionSettles()

		expect(decisions).toEqual([{ kind: 'reject' }])
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
		expect(frame).toContain('approve all for this session')
		expect(frame).toContain('the agent tries something else')
		// The advertisement is the contract the handler is held to. `enter` must
		// not appear, because Enter no longer does anything here.
		expect(frame.toLowerCase()).not.toContain('enter')
	})

	it('names the key that stops the turn, and says that it is different', async () => {
		// `n`/`esc` decline this batch and the agent carries on trying something
		// else; `ctrl+c` declines AND ends the turn. Two outcomes, and only the
		// first was on the screen — so an operator who wanted namzu to stop
		// pressed `n`, watched it continue, and had no way to learn otherwise
		// from the box they were reading. The distinction was written down only
		// in `docs/cli/tools.md`.
		const { lastFrame } = await promptOpenWithDraftInFlight()
		const frame = lastFrame() ?? ''

		expect(frame.toLowerCase(), 'the key that stops the turn is unnamed').toContain('ctrl+c')
		expect(frame, 'named the key without naming what makes it different').toContain(
			'stop the turn',
		)
	})

	it('ctrl+c does what the overlay now says it does', async () => {
		// The other half, and the reason the line above is allowed to claim it:
		// an advertisement is only worth adding if the key behaves that way. The
		// batch is declined AND the turn is aborted, where `n` declines only.
		const { stdin } = await promptOpenWithDraftInFlight()

		stdin.write('\x03')
		await decisionSettles()

		expect(decisions).toEqual([{ kind: 'reject', feedback: 'User interrupted.' }])
	})
})

/**
 * That `/permissions` reports the posture actually in force.
 *
 * Here rather than in `slashCommands.test.ts` because the unit test there can
 * only prove that `renderPermissions` calls the reader it is handed. Whether
 * `App` hands it a LIVE reader or a value snapshotted during some earlier
 * render is a different property, invisible from that level, and it is the one
 * that was broken: the latch lives in a closure inside the agent session, and
 * the context object carrying it is assembled on one render and read from a
 * callback captured on another.
 *
 * So this drives the whole path — press `a` at a real prompt, then ask.
 */
describe('/permissions after approve-all', () => {
	it('reports automatic approval once `a` has been pressed', async () => {
		const { stdin, lastFrame } = await promptOpenWithDraftInFlight()

		settle()
		stdin.write('a')
		await decisionSettles()
		expect(decisions, 'a did not approve-all').toEqual([{ kind: 'approve-all' }])

		// The turn is over and the composer is back — still holding the draft
		// that was typed while it ran, which is the point of the fix in
		// `app-draft-survives.test.tsx`. Clear it before typing a command, or
		// the command is appended to the draft and submitted as prose.
		//
		// Worth naming: this step was not needed while the composer unmounted,
		// so this test used to pass BECAUSE the draft was being destroyed.
		await tick(120)
		stdin.write('\x1B')
		await tick(60)
		stdin.write('/permissions')
		await tick(60)
		stdin.write('\r')
		await tick(200)

		const frame = lastFrame() ?? ''
		expect(frame, 'the readout never rendered').toContain('Unreviewed calls')
		expect(frame).toContain('approved automatically')
		expect(frame, 'still claims calls are reviewed').not.toContain('you are asked')
		// And that App hands the readout the REAL never-prompted set. The unit
		// test supplies its own list, so it would pass just as happily against an
		// empty one — this is the assertion that fails if the wiring is dropped.
		expect(frame, 'the never-prompted disclosure is missing').toContain('Never prompted')
		expect(frame).toContain('glob')
	})
})
