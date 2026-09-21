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
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
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
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
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
					toolCalls: [
						{
							id: 'c1',
							name: 'bash',
							input: { command: 'rm -rf build' },
							isDestructive: true,
						},
					],
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
 * Everything this harness has drawn, as one line of words.
 *
 * Two readers are possible and they answer different questions, so this file
 * uses both deliberately:
 *
 *   - `lastFrame` is the SCREEN. "The composer is up", "the turn is running",
 *     "the draft is still there" are claims about what is on screen now, and
 *     only the screen answers them: history still holds the frame the last of
 *     those claims says has been replaced, so an assertion that a draft
 *     survived the prompt, read through history, passes even when the prompt
 *     destroyed it — which is the defect under test. Measured, not assumed:
 *     with the draft destroyed on purpose, the screen reader goes red and the
 *     history reader stays green.
 *   - `frames` is the HISTORY. "The draft reached the composer", "the chip
 *     appeared", "the interrupt landed" are events: they happened, and which
 *     frame happens to be last afterwards cannot un-happen them. A frame the
 *     renderer wrapped is the second reason — a needle that straddles the wrap
 *     point is in the text and not in the row that carries it.
 *
 *     It is worth being exact about what history does NOT buy here, because a
 *     reader kept for a wrong reason is a reader that will be dropped for a
 *     wrong reason. This is not about `<Static>` rows going missing from later
 *     frames: ink-testing-library renders through ink with `debug: true`, and
 *     ink's debug path writes the accumulated static output and the live frame
 *     in one write, so every later frame does carry every static row. Measured
 *     over repeated cycles, no frame was ever a static-only chunk.
 *
 * Escapes come off BEFORE the whitespace is collapsed. Collapsing whitespace
 * alone leaves an escape sequence sitting where a line happened to wrap, so
 * `…and then deploy` survives as `and then <esc>deploy` and a `toContain` for
 * the sentence fails on the renderer's width rather than on anything the code
 * did.
 */
function said(harness: { readonly frames: readonly string[] }): string {
	return (
		harness.frames
			.join('\n')
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
			.replace(/\u001b\[[0-9;]*m/g, '')
			.replace(/\s+/g, ' ')
	)
}

/**
 * Wait for `read()` to say `text`, and FAIL the test if it never does.
 *
 * Polling rather than one fixed sleep, for a reason this suite has already paid
 * for twice: the run transforms TypeScript on the way in, so under the full
 * parallel suite a step that takes 40ms alone can take several hundred. A fixed
 * wait turns that into a red assertion with nothing about the code changed.
 * Absence still needs a fixed wait — a thing that must never appear cannot be
 * polled for — which is why the `not.toContain` assertions below sit after a
 * wait on the positive fact that precedes them.
 *
 * It asserts rather than returning quietly, for the reason this file was filed
 * as flaky. A poll whose needle stops arriving must report that; a poll that
 * gives up in silence reports it as five passing tests that took 3s each, which
 * is how a renamed label or a removed row turns into a budget nobody reads.
 * `why` is that report.
 *
 * `read` is either the current screen (`harness.lastFrame`) or the history
 * (`() => said(harness)`); which one is a property of the claim, see
 * {@link said}.
 */
async function frameShows(
	read: () => string | undefined,
	text: string,
	why: string,
	timeoutMs = 3_000,
): Promise<void> {
	const started = performance.now()
	while (!(read() ?? '').includes(text) && performance.now() - started < timeoutMs) {
		await tick(20)
	}
	expect(read(), why).toContain(text)
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
	await frameShows(harness.lastFrame, 'Type a message', 'the composer never appeared')
	// Keys go in separately: one `stdin.write` is one keypress, so 'go\r' would
	// arrive as pasted text and never submit. Nothing is waited for in between:
	// the composer keeps `valueRef` in step inside the key handler itself, so
	// the return key sees 'go' whether or not React has committed the render.
	harness.stdin.write('go')
	harness.stdin.write('\r')
	// Wait on the screen, not on the mock's first delta.
	//
	// This used to poll for the delta's own text, `'working'`, on the premise
	// that it would reach the screen and mark the submit processed. It cannot:
	// the renderer releases whole blocks (`splitCompleteBlocks`) and, when a
	// paragraph drags, whole sentences (`splitSafeCut`) — neither will cut a
	// bare word with no blank line after it loose, so the pending buffer held
	// it for the life of the turn and the poll spent its entire budget on every
	// test that came through here. A wait whose condition can never become true
	// is the same defect as a wall clock, with a longer fuse.
	//
	// `Working` is the live activity row, drawn while a turn is in flight —
	// `App.tsx` passes `state === 'thinking' || state === 'tool'`, and a running
	// tool lights the row too, though nothing here runs one before the draft.
	// That the submit was processed and the composer is live and free again is
	// exactly what this wait needs and what the row states.
	await frameShows(harness.lastFrame, 'Working', 'the turn never started')
	harness.stdin.write(draft)
	// The draft reaching the composer is an event, so it is read from history.
	await frameShows(() => said(harness), draft, 'the draft never reached the composer')
	// The draft is in. The prompt may open now.
	letThePromptOpen()
	return harness
}

describe('a draft while a permission prompt comes and goes', () => {
	it('is still there after the prompt is answered', async () => {
		const draft = 'and then deploy'
		const harness = await turnRunningWithDraft(draft)

		// The prompt takes the screen. The draft is deliberately not shown while
		// it is up — the composer is hidden, not unmounted. Waiting on the screen
		// matters here: the Esc below has to reach an OPEN prompt.
		await frameShows(harness.lastFrame, 'Do you want to', 'the prompt never opened')

		// Answer it, and the composer comes back with the sentence intact.
		harness.stdin.write('\x1B')
		// "Still there" is a claim about the screen. History would be satisfied by
		// the frame from before the prompt, which is the state this asserts against.
		await frameShows(harness.lastFrame, draft, 'the draft was destroyed by the prompt')

		expect(decisions).toEqual([{ kind: 'reject' }])
	})

	it('keeps a pasted attachment across the same cycle', async () => {
		// Text is the visible half; the chips are the half a user would only
		// notice after sending an incomplete message.
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message', 'the composer never appeared')
		harness.stdin.write('go')
		harness.stdin.write('\r')
		// The turn is running and the composer is free again, read off the screen.
		await frameShows(harness.lastFrame, 'Working', 'the turn never started')
		// A newline in one keypress is held as a paste chip.
		harness.stdin.write('first line\nsecond line')
		// The chip appearing is an event — the keystrokes landed as a chip rather
		// than being dropped by a composer that was not free.
		await frameShows(() => said(harness), 'Pasted text', 'the paste chip never appeared')

		letThePromptOpen()
		await frameShows(harness.lastFrame, 'Do you want to', 'the prompt never opened')
		harness.stdin.write('\x1B')
		// The chip coming back is a claim about the screen, for the same reason
		// the draft is: history holds the frame from before the prompt.
		await frameShows(harness.lastFrame, 'Pasted text', 'the paste chip was destroyed')
	})
})

describe('esc while a turn is running', () => {
	it('interrupts the turn without clearing the draft', async () => {
		// The status bar tells the operator Esc interrupts. Doing what it says
		// must not also empty the composer.
		askPermission = false
		const draft = 'keep me'
		const harness = await turnRunningWithDraft(draft)

		harness.stdin.write('\x1B')
		await frameShows(() => said(harness), 'Interrupted', 'the turn was not interrupted')
		// The draft, by contrast, has to be on the screen NOW: Esc clearing it is
		// exactly the defect, and history still holds the frame from before.
		expect(harness.lastFrame(), 'esc cleared the draft').toContain(draft)
	})

	it('still clears the composer when nothing is running', async () => {
		// The other half: Esc must not become inert. With no turn in flight it
		// is the composer's own clear, which is what it is for.
		askPermission = false
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		// The placeholder is drawn only while the composer is enabled and empty,
		// which is the state a keystroke needs. A composer that is drawn but
		// disabled for a moment (compacting, an external editor request) would not
		// satisfy it, so this says more than "the composer is on screen" — and it
		// says it without a guess at how long the probe takes.
		await frameShows(harness.lastFrame, 'Type a message', 'the composer never appeared')
		harness.stdin.write('throwaway')
		// The keystrokes landing is an event; polling for it is what makes this a
		// statement about the composer rather than about the machine's load.
		await frameShows(
			() => said(harness),
			'throwaway',
			'the keystrokes never reached the composer',
		)

		harness.stdin.write('\x1B')
		// An empty composer draws the placeholder again, in the same render that
		// drops the text — so the placeholder returning is the completion to wait
		// for. A fixed wait here asks whether the machine got to it in time.
		await frameShows(harness.lastFrame, 'Type a message', 'the composer never came back empty')

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
		const harness = await turnRunningWithDraft(draft)
		await frameShows(harness.lastFrame, 'Do you want to', 'the prompt never opened')
		expect(harness.lastFrame(), 'the composer is still drawing under the prompt').not.toContain(draft)

		// `q` decides nothing at the prompt; it must not reach the composer. Both
		// keys go in now, in order, with nothing waited for between them: the
		// question is whether a keystroke the prompt owns can reach the draft, and
		// a wait would only ask it later.
		harness.stdin.write('q')
		settle()
		harness.stdin.write('\x1B')
		await frameShows(harness.lastFrame, draft, 'the draft did not survive the prompt')

		expect(harness.lastFrame(), 'a key meant for the prompt landed in the draft').not.toContain(
			`${draft}q`,
		)
	})
})
