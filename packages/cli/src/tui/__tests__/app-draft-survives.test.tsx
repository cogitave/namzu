/**
 * A draft survives the things the operator did not do.
 *
 * The composer holds the draft in its own state, and two separate mechanisms
 * used to destroy it without a deliberate keystroke:
 *
 * 1. The permission overlay was rendered in a ternary AGAINST the composer, so
 *    a prompt arriving mid-sentence unmounted it and took the sentence with it.
 * 2. Esc while a turn runs fires both handlers — App aborts the turn, and the
 *    composer cleared itself. The status bar advertises Esc as the interrupt,
 *    so following the instruction on screen destroyed the draft.
 *
 * These assert against a rendered `<App>` driving a real turn and a real prompt
 * cycle, because "the state hook still holds a value" is not the claim. The
 * claim is that the text is back on screen afterwards.
 *
 * Not a terminal: this reads Ink's frames, so it establishes what was rendered,
 * not how it looks or feels at human speed.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, PermissionDecision, PermissionRequest } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

const decisions: PermissionDecision[] = []
/** Held open so the test controls when the prompt appears. */
let askPermission = true

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
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
			// The TUI never resumes a durable run; a stub that answered would
			// make a resume look reachable from here.
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => ['read'],
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				yield { kind: 'delta', text: 'working' } as AgentEvent
				if (!askPermission) {
					// The interrupt tests need the turn to STILL BE RUNNING when Esc
					// arrives, because that is the only state in which Esc is the
					// interrupt at all — with nothing in flight it is the composer's
					// own clear, which is the very next test down.
					//
					// So the turn ends on the abort rather than on a wall clock. It
					// used to end after a fixed 120ms, which made "is the turn still
					// running" a question about how loaded the machine was: under the
					// full parallel suite the turn finished before the keystroke
					// landed, Esc cleared the draft as designed, and the failure
					// reported was "the turn was not interrupted" — a true statement
					// about a turn that was already over.
					await Promise.race([
						new Promise<void>((resolve) => {
							if (opts?.signal?.aborted) return resolve()
							opts?.signal?.addEventListener('abort', () => resolve(), { once: true })
						}),
						// A backstop so a test that never interrupts cannot hang the
						// run. It is not the mechanism; if it is what ends a turn,
						// something above went wrong.
						new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
					])
					return
				}
				// The prompt opens when the test says it has finished typing, not
				// after a duration.
				//
				// It used to wait 120ms, described as "long enough for the test to
				// type into a live composer" — which made "was the composer still
				// live" a question about how loaded the machine was. Under the full
				// parallel suite the prompt could open first, the keystrokes were
				// dropped by a composer that is disabled while a prompt is up, and
				// the failure reported was "the draft never reached the composer": a
				// true statement about a composer that was never asked. It is the
				// same defect the branch above already fixed by waiting on the abort
				// signal instead of a clock.
				await permissionGate
				const req: PermissionRequest = {
					toolCalls: [{ id: 'c1', name: 'bash', summary: 'rm -rf build', isDestructive: true }],
				}
				const decision = await opts?.onPermission?.(req)
				if (decision) decisions.push(decision)
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: process.cwd(), version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))

/**
 * Wait for `text` to appear in the frame, or give up.
 *
 * Polling rather than one fixed sleep, for a reason this suite has already paid
 * for twice: the run transforms TypeScript on the way in, so under the full
 * parallel suite a step that takes 40ms alone can take several hundred. A fixed
 * wait turns that into a red assertion with nothing about the code changed.
 * Absence still needs a fixed wait — it cannot be polled for — which is why the
 * `not.toContain` assertions below sit after a generous one.
 */
async function frameShows(
	lastFrame: () => string | undefined,
	text: string,
	timeoutMs = 3_000,
): Promise<void> {
	const started = performance.now()
	while (!(lastFrame() ?? '').includes(text) && performance.now() - started < timeoutMs) {
		await tick(20)
	}
}

let nowMs = 1_000_000
const mounted: { unmount: () => void }[] = []

/**
 * Held closed until the test has finished typing into the live composer.
 *
 * The permission prompt disables the composer, so every keystroke a test wants
 * to leave in a draft has to land before the prompt opens. Sequencing that on a
 * timer makes the test a race against the machine; the mocked turn waits on
 * this instead, and {@link letThePromptOpen} is the test saying it is ready.
 */
let permissionGate: Promise<void> = Promise.resolve()
let letThePromptOpen: () => void = () => {}

beforeEach(() => {
	decisions.length = 0
	askPermission = true
	nowMs = 1_000_000
	permissionGate = new Promise<void>((resolve) => {
		letThePromptOpen = resolve
	})
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

function settle(): void {
	nowMs += APPROVAL_SETTLE_MS + 1
}

/** Ready, with a turn running and `draft` typed into the live composer. */
async function turnRunningWithDraft(draft: string) {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	// Wait for the composer to exist rather than guessing at how long the probe
	// takes. Writing before it mounts loses the keystrokes silently.
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	// Keys go in separately: one `stdin.write` is one keypress, so 'go\r' would
	// arrive as pasted text and never submit.
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	// Wait for the turn to actually start rather than assuming 40ms is enough.
	// The mock streams "working" as its first delta, so its arrival is the
	// signal that the submit was processed and the composer is free again.
	await frameShows(harness.lastFrame, 'working')
	harness.stdin.write(draft)
	await frameShows(harness.lastFrame, draft)
	expect(harness.lastFrame(), 'the draft never reached the composer').toContain(draft)
	// The draft is in. The prompt may open now.
	letThePromptOpen()
	return harness
}

describe('a draft while a permission prompt comes and goes', () => {
	it('is still there after the prompt is answered', async () => {
		const draft = 'and then deploy'
		const { stdin, lastFrame } = await turnRunningWithDraft(draft)

		// The prompt takes the screen. The draft is deliberately not shown while
		// it is up — the composer is hidden, not unmounted.
		await frameShows(lastFrame, 'wants to run')
		expect(lastFrame(), 'the prompt never opened').toContain('wants to run')

		// Answer it, and the composer comes back with the sentence intact.
		stdin.write('\x1B')
		await frameShows(lastFrame, draft)

		expect(decisions).toEqual([{ kind: 'reject' }])
		expect(lastFrame(), 'the draft was destroyed by the prompt').toContain(draft)
	})

	it('keeps a pasted attachment across the same cycle', async () => {
		// Text is the visible half; the chips are the half a user would only
		// notice after sending an incomplete message.
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		harness.stdin.write('go')
		await tick(20)
		harness.stdin.write('\r')
		// The turn's first delta, so the submit has been processed and the
		// composer is free again. A fixed wait here is a guess about the machine.
		await frameShows(harness.lastFrame, 'working')
		// A newline in one keypress is held as a paste chip.
		harness.stdin.write('first line\nsecond line')
		await frameShows(harness.lastFrame, 'Pasted text')
		expect(harness.lastFrame(), 'the paste chip never appeared').toContain('Pasted text')

		letThePromptOpen()
		await frameShows(harness.lastFrame, 'wants to run')
		expect(harness.lastFrame()).toContain('wants to run')
		harness.stdin.write('\x1B')
		await frameShows(harness.lastFrame, 'Pasted text')

		expect(harness.lastFrame(), 'the paste chip was destroyed').toContain('Pasted text')
	})
})

describe('esc while a turn is running', () => {
	it('interrupts the turn without clearing the draft', async () => {
		// The status bar tells the operator Esc interrupts. Doing what it says
		// must not also empty the composer.
		askPermission = false
		const draft = 'keep me'
		const { stdin, lastFrame } = await turnRunningWithDraft(draft)

		stdin.write('\x1B')
		await frameShows(lastFrame, 'Interrupted')

		expect(lastFrame(), 'the turn was not interrupted').toContain('Interrupted')
		expect(lastFrame(), 'esc cleared the draft').toContain(draft)
	})

	it('still clears the composer when nothing is running', async () => {
		// The other half: Esc must not become inert. With no turn in flight it
		// is the composer's own clear, which is what it is for.
		askPermission = false
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await tick(80)
		harness.stdin.write('throwaway')
		await tick(40)
		expect(harness.lastFrame()).toContain('throwaway')

		harness.stdin.write('\x1B')
		await tick(120)

		expect(harness.lastFrame(), 'esc did not clear an idle composer').not.toContain('throwaway')
	})
})

describe('while the prompt is up', () => {
	it('the composer draws nothing and takes no keys', async () => {
		// Hidden has to mean hidden: a keystroke aimed at the prompt must not
		// also be appended to the draft behind it.
		//
		// Honest about what this pins: the "takes no keys" half is currently
		// enforced by `disabled`, not by `hidden`, because a permission prompt
		// sets both. Removing `hidden` from the composer's input guard leaves
		// this test green — verified by mutation. What it does pin is the
		// outcome, which is the thing that matters if either flag later moves.
		const draft = 'untouched'
		const { stdin, lastFrame } = await turnRunningWithDraft(draft)
		await frameShows(lastFrame, 'wants to run')
		expect(lastFrame()).toContain('wants to run')
		expect(lastFrame(), 'the composer is still drawing under the prompt').not.toContain(draft)

		// `q` decides nothing at the prompt; it must not reach the composer.
		stdin.write('q')
		await tick(60)
		settle()
		stdin.write('\x1B')
		await frameShows(lastFrame, draft)

		expect(lastFrame()).toContain(draft)
		expect(lastFrame(), 'a key meant for the prompt landed in the draft').not.toContain(
			`${draft}q`,
		)
	})
})
