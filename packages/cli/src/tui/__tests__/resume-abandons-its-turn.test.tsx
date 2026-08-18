/**
 * What `/resume` does to the turn it interrupts — asserted against a rendered
 * `<App>`.
 *
 * The defect this pins had three independent halves, and each needs its own
 * assertion, because any one of the three fixes makes the other two look
 * covered:
 *
 *   1. the running turn was never aborted at all;
 *   2. its later events appended into the RESUMED transcript, dated as though
 *      they belonged there;
 *   3. its `appendMessages` wrote into the RESUMED conversation's durable
 *      record, because `sessionId` was mutated on a `RunScope` the running loop
 *      held the same object of. That one outlived the process.
 *
 * The fake session keeps yielding after the abort, and it is worth being exact
 * about what that models. `abort()` returns immediately and the `for await`
 * unwinds whenever it gets there, so the window is real — but the BUILT-IN
 * session checks the signal at the top of each iteration and returns after one
 * `error: aborted`, so on that implementation very little arrives in it. This
 * fake is therefore a session that notices the signal LATE, which is the case
 * the guards have to hold for and the only one in which they are observable at
 * all. A generator that stopped politely would close the window and make halves
 * 2 and 3 untestable; claiming it is what the shipped session does would be a
 * different error, so it is not claimed.
 *
 * The second test is the other side, and it is the one that was correct only by
 * placement: cancelling the picker must leave everything alone, and nothing
 * said so.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** The conversation the turn is started in, and the one `/resume` moves to. */
const STARTED_IN = 'conv-started-in'
const RESUMED = 'conv-resumed'

/** Every `appendMessages` call, with the conversation it named. */
const appended: Array<{ sessionId: string; contents: string[] }> = []

/**
 * One gate per turn, standing in for a tool still running.
 *
 * Two, because the sharpest case needs a SECOND turn started in the resumed
 * conversation while the first is still unwinding — the moment where the
 * abandoned turn's cleanup would reset somebody else's screen.
 */
const gates: Array<{ wait: Promise<void>; release: () => void }> = []
function nextGate() {
	let release: () => void = () => {}
	const wait = new Promise<void>((r) => {
		release = r
	})
	const g = { wait, release }
	gates.push(g)
	return g
}

/** Per-turn signals, indexed by the order the turns were started. */
const signals: Array<AbortSignal | undefined> = []

/** Whether the first turn's signal had been aborted by the time it resumed. */
let abortSeenAtRelease = false

/** Set by a test that wants the conversation read to fail. */
let loadShouldFail = false
/** Set by a test that wants the write of the abandoned turn to fail. */
let appendShouldFail = false
/** Held by a test that wants the conversation read to take an observable while. */
let readHeld: Promise<void> | null = null
let releaseTheRead: () => void = () => {}
function holdTheRead(): void {
	readHeld = new Promise<void>((r) => {
		releaseTheRead = r
	})
}
/** Set by a test that wants the abandoned turn to end by throwing. */
let throwAtEnd = false
/** Set by a test that wants the abandoned turn parked on a permission prompt. */
let askPermission = false
/** Whether the first turn has asked, and what it was told. */
let permissionAsked = false
const decisions: unknown[] = []

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))

vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => STARTED_IN,
	appendMessages: async (_s: unknown, sessionId: string, messages: readonly { content: unknown }[]) => {
		appended.push({
			sessionId,
			contents: messages.map((m) => (typeof m.content === 'string' ? m.content : '')),
		})
		if (appendShouldFail) throw new Error('ENOSPC: no space left on device')
	},
	listRecent: async () => [
		{ id: RESUMED, title: 'An earlier conversation', updatedAt: new Date().toISOString(), count: 2 },
	],
	loadConversation: async () => {
		if (readHeld) await readHeld
		if (loadShouldFail) throw new Error('DISKUNREADABLE')
		return [
			{ role: 'user', content: 'RESTOREDQUESTION', timestamp: 1 },
			{ role: 'assistant', content: 'RESTOREDANSWER', timestamp: 2 },
		]
	},
}))

vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
			errorHint: null,
			// Required since #329 made the session say WHY it has no provider.
			// Absent here because main does not build without it: this stub and
			// that field landed in two PRs that each passed CI without seeing the
			// other.
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			// The TUI never resumes a durable run; a stub that answered would make
			// a resume look reachable from here.
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			// One row before the operator can act, then the wait, then the events
			// that must land in the right place — or nowhere.
			//
			// It goes on yielding AFTER the abort on purpose. That is what a real
			// one does — `abort()` returns and the loop unwinds whenever it gets
			// there — and a generator that stopped politely on the signal would
			// close the very window the other two halves of this defect live in.
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				const turn = signals.length
				signals.push(opts?.signal)
				const gate = nextGate()
				// A delta BEFORE the wait, so the turn owns a streaming assistant row
				// in the transcript that `/resume` then throws away. That is the shape
				// where a late `appendToMessage` would target an id belonging to the
				// discarded array and no-op in silence — invisible to a turn whose
				// first event is a tool call.
				yield { kind: 'delta', text: `EARLY${turn} ` } as AgentEvent
				yield {
					kind: 'tool-start',
					toolUseId: 'c1',
					toolName: 'bash',
					summary: `RUNNING${turn}`,
				} as AgentEvent
				await gate.wait
				if (askPermission && turn === 0) {
					permissionAsked = true
					const decision = await opts?.onPermission?.({
						toolCalls: [{ id: 'call-1', name: 'bash', summary: 'rm -rf build', isDestructive: true }],
					})
					if (decision) decisions.push(decision)
				}
				if (turn === 0) abortSeenAtRelease = opts?.signal?.aborted === true
				yield {
					kind: 'tool-end',
					toolUseId: 'c1',
					toolName: 'bash',
					summary: `LEAKEDTOOL${turn}`,
					isError: false,
				} as AgentEvent
				yield { kind: 'delta', text: `LEAKEDREPLY${turn}` } as AgentEvent
				if (throwAtEnd && turn === 0) throw new Error('TURNBLEWUP')
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: process.cwd(), version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	appended.length = 0
	gates.length = 0
	signals.length = 0
	abortSeenAtRelease = false
	loadShouldFail = false
	appendShouldFail = false
	readHeld = null
	throwAtEnd = false
	askPermission = false
	permissionAsked = false
	decisions.length = 0
})

afterEach(() => {
	// Released whatever the test did, so a failing assertion cannot leave a
	// generator or a read parked forever and take the next file down with it.
	for (const g of gates) g.release()
	releaseTheRead()
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

/**
 * Everything that was ever rendered, as one line of words.
 *
 * Read across `frames` rather than `lastFrame`, because finalized rows print
 * once through `<Static>` and a later frame need not carry them — so
 * `lastFrame` alone would be satisfied by output that DID land.
 *
 * Whitespace-collapsed, because Ink wraps at the terminal width and a sentence
 * long enough to matter is a sentence long enough to wrap. An assertion holding
 * a phrase that straddles the wrap point passes or fails on where the renderer
 * broke the line, which is a fact about the column count of whoever ran it: this
 * file went green locally and red on CI for exactly that, with the sentence
 * plainly present in the dump. Matching words rather than layout is the fix.
 */
function said(harness: { frames: readonly string[] }): string {
	return (
		harness.frames
			.join('\n')
			// Colour codes FIRST, then whitespace. Collapsing whitespace alone
			// leaves an escape sequence sitting where a line happened to wrap, so
			// `…conversation it started in` survives as `it <esc>started` and a
			// `toContain` for the sentence fails — on the renderer's width rather
			// than on anything the code did. It passed at one terminal width and
			// not another, which is the tell.
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
			.replace(/\u001b\[[0-9;]*m/g, '')
			.replace(/\s+/g, ' ')
	)
}

/** Wait for a frame to say something, rather than sleeping a fixed interval. */
async function untilFrame(
	harness: { lastFrame: () => string | undefined },
	needle: string,
	why: string,
): Promise<void> {
	const started = performance.now()
	while (!(harness.lastFrame() ?? '').includes(needle) && performance.now() - started < 3_000) {
		await tick(20)
	}
	expect(harness.lastFrame(), why).toContain(needle)
}

/**
 * Render, run a turn until it parks on the gate, and open the `/resume` picker.
 *
 * Polled rather than slept through, for the reason `app-permission-keys`
 * documents: a fixed wait passes this file alone and fails under the full
 * parallel run, and the failure is reported as whatever the test was about.
 */
async function pickerOpenMidTurn() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await tick(60)
	await submit(harness, 'go')
	harness.stdin.write('/resume')
	await tick(30)
	harness.stdin.write('\r')
	await untilFrame(harness, 'Resume a conversation', 'the resume picker never opened')
	return harness
}

/**
 * Type and send.
 *
 * The keys go in separately because Ink delivers one `stdin.write` as ONE
 * keypress: `'go\r'` arrives with `key.return` false and is taken as pasted
 * text, so nothing is ever submitted and the test asserts against a turn that
 * never ran.
 */
async function submit(harness: { stdin: { write: (s: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\r')
	await tick(60)
}

/** Wait until `n` turns have persisted themselves. */
async function appendsReach(n: number, timeoutMs = 3_000): Promise<void> {
	const started = performance.now()
	while (appended.length < n && performance.now() - started < timeoutMs) await tick(20)
}

describe('/resume while a turn is running', () => {
	it('aborts it, keeps its output out of the resumed transcript, and saves it where it belongs', async () => {
		const harness = await pickerOpenMidTurn()

		harness.stdin.write('\r')
		// The resumed conversation has to be on screen before the old turn is let
		// go, or the test proves nothing about ordering.
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')

		gates[0]?.release()
		await appendsReach(1)
		await tick(120)

		// 1 — it was actually stopped. Without this the two assertions below still
		// pass, because the transcript guard and the captured destination each
		// hold on their own; a `/resume` that quietly let the turn keep running
		// would go unreported.
		expect(abortSeenAtRelease, 'the running turn was never aborted').toBe(true)

		// 2 — nothing from it reached the screen after the switch. `said` reads
		// across every frame and collapses the wrapping; see its docblock for why
		// both halves of that matter.
		const everything = said(harness)
		expect(everything, "the abandoned turn's tool row landed in the resumed transcript").not.toContain(
			'LEAKEDTOOL0',
		)
		expect(everything, "the abandoned turn's reply landed in the resumed transcript").not.toContain(
			'LEAKEDREPLY0',
		)

		// 3 — the durable half. It must be written to the conversation it was
		// started in, and to no other.
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
		// And whole: the events after the switch are consumed even though they are
		// not rendered, so the saved reply is not truncated at the moment the
		// operator happened to leave.
		expect(appended[0]?.contents.join(' '), 'the saved reply stops where the operator left').toContain(
			'LEAKEDREPLY0',
		)

		// The reply the operator watched begin, before the switch, is part of what
		// is saved — and its row is gone from the screen, so a late write against
		// its id would be a silent no-op nothing else here would notice.
		expect(appended[0]?.contents.join(' ')).toContain('EARLY0')

		// 4 — and the operator is told, because those rows are correctly missing
		// from the transcript they are now looking at.
		expect(everything, 'the abandoned turn was dropped in silence').toContain(
			'being saved to the conversation it started in',
		)
	})

	it('says so when the abandoned turn could not be saved after all', async () => {
		// The notice above says the reply is BEING saved, present tense, because
		// the write has not happened when it is printed. It runs later, detached,
		// and its rejection used to be swallowed whole — so a resume could promise
		// a turn was going somewhere and nothing would ever say it did not arrive.
		// That is the same defect as the one being fixed, one step further on.
		appendShouldFail = true
		const harness = await pickerOpenMidTurn()

		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')
		gates[0]?.release()
		await untilFrame(harness, 'was not saved', 'the failed write was silent')

		const everything = said(harness)
		// Named, so it does not read as a fault of the conversation on screen.
		expect(everything, 'did not say which conversation lost the turn').toContain(STARTED_IN)
		expect(everything, 'named the fault without naming the consequence').toContain('context')
	})

	it('keeps the picker until the conversation is actually read', async () => {
		// The composer is live in the `ready` phase, and handing it back before the
		// read settles gives a message nowhere to go: queued against a conversation
		// being left, then dropped by the interrupt or sent somewhere nobody
		// addressed it. Esc stops cancelling for the same interval — the choice is
		// already being acted on.
		holdTheRead()
		const harness = await pickerOpenMidTurn()

		harness.stdin.write('\r')
		await tick(120)
		expect(harness.lastFrame(), 'the screen was handed back mid-read').toContain(
			'Resume a conversation',
		)

		harness.stdin.write('\x1B')
		await tick(80)
		expect(harness.lastFrame(), 'esc cancelled a resume already under way').toContain(
			'Resume a conversation',
		)

		releaseTheRead()
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')
	})

	it('keeps the abandoned turn from reporting its own failure into the resumed transcript', async () => {
		// The other end of the same event loop. An abandoned turn that ENDS BADLY
		// would print `Error: …` into a conversation that had nothing to do with
		// it — the more confusing half, because an interrupted turn failing reads
		// to the operator as the resumed conversation failing.
		throwAtEnd = true
		const harness = await pickerOpenMidTurn()

		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')

		gates[0]?.release()
		await appendsReach(1)
		await tick(120)

		expect(
			said(harness),
			"the abandoned turn's failure was reported into the resumed conversation",
		).not.toContain('TURNBLEWUP')
		// It still saved what it had, into its own conversation. A turn that fails
		// is not a turn that produced nothing.
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
	})

	it('leaves the screen to the turn that has started since', async () => {
		// The reason the abandoned turn's cleanup is guarded rather than
		// unconditional. It unwinds long after the switch — by then a turn in the
		// resumed conversation can already be running, and a `finally` that
		// cleared the abort handle would leave that turn unstoppable: `Esc` would
		// do nothing, with no way to tell from the screen.
		const harness = await pickerOpenMidTurn()
		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')

		await submit(harness, 'ask again')
		// Both turns are now live: the abandoned one still unwinding, the new one
		// parked on its own gate.
		expect(gates.length, 'the second turn never started').toBe(2)
		await untilFrame(harness, 'RUNNING1', 'the second turn is not showing as running')

		gates[0]?.release()
		await appendsReach(1)
		await tick(150)

		// The live region is the visible half: the abandoned turn's cleanup would
		// clear the active-tool list, so the turn still working would stop looking
		// like it was — and the queue effect, which only runs while the screen says
		// idle, would start firing follow-ups into the middle of it.
		expect(harness.lastFrame(), "the abandoned turn cleared the live turn's state").toContain(
			'RUNNING1',
		)
		// And the invisible half: the abort handle. `Esc` would do nothing, with
		// nothing on the screen to say why.
		harness.stdin.write('\x1B')
		await tick(120)
		expect(signals[1]?.aborted, 'Esc no longer stops the turn on screen').toBe(true)
	})

	it('does not send a queued follow-up into the conversation it lands in', async () => {
		// The composer stays live while the agent works — that is what message
		// queuing is built on — so a follow-up meant for THIS conversation is
		// sitting in the queue at the moment the operator leaves it. The queue
		// drains the instant the screen goes idle, which the interrupt is what
		// makes happen, so the follow-up would be asked of a conversation nobody
		// addressed it to. Interrupting means stop, not "run the next one
		// somewhere else" — the same reason Esc and Ctrl+C drop it.
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await tick(60)
		await submit(harness, 'go')
		await submit(harness, 'FOLLOWUP')
		await untilFrame(harness, 'queued', 'the follow-up was not queued')

		harness.stdin.write('/resume')
		await tick(30)
		harness.stdin.write('\r')
		await untilFrame(harness, 'Resume a conversation', 'the resume picker never opened')
		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')
		await tick(200)

		expect(gates.length, 'the queued follow-up ran in the resumed conversation').toBe(1)
	})

	it('drops a queued prompt even when the old turn settles behind the picker first', async () => {
		// This is the idle edge the ordinary interrupt case above cannot reach.
		// The picker pauses queue draining. Letting the old turn finish while it is
		// open removes abortRef, so a cleanup tied only to "was there a running
		// turn?" returns early and hands the queued prompt to the resumed scope.
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await tick(60)
		await submit(harness, 'go')
		await submit(harness, 'IDLE_EDGE_FOLLOWUP')
		await untilFrame(harness, 'queued', 'the follow-up was not queued')

		harness.stdin.write('/resume')
		await tick(30)
		harness.stdin.write('\r')
		await untilFrame(harness, 'Resume a conversation', 'the resume picker never opened')

		// Finish the source turn while the picker still owns the screen. The queue
		// remains because its pump requires phase=ready, but there is no active
		// AbortController left for `interruptTurn` to find.
		gates[0]?.release()
		await appendsReach(1)
		await tick(100)

		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')
		await untilFrame(harness, 'Discarded 1 queued prompt', 'the dropped prompt was not accounted for')
		await tick(200)

		expect(gates.length, 'the idle-edge prompt crossed into the resumed conversation').toBe(1)
		expect(appended.map((entry) => entry.sessionId)).toEqual([STARTED_IN])
	})

	it('settles a permission prompt the abandoned turn was parked on', async () => {
		// The picker opens on an `await`, so a tool batch can reach the prompt
		// while it is up — and the resume picker owns the keyboard ahead of the
		// prompt, so the operator resumes without ever answering it.
		//
		// A turn parked on that promise never reaches its own `finally`, which is
		// where its reply is saved. An abort alone leaves it there forever: the
		// work is not stopped, it is suspended, and the partial reply the operator
		// watched arrive is never written anywhere. So the interrupt answers it,
		// with the decision Ctrl+C sends at that same prompt.
		askPermission = true
		const harness = await pickerOpenMidTurn()

		gates[0]?.release()
		const started = performance.now()
		while (!permissionAsked && performance.now() - started < 3_000) await tick(20)
		expect(permissionAsked, 'the turn never reached the prompt').toBe(true)

		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')
		await appendsReach(1)

		expect(decisions, 'the prompt was left unanswered, so the turn never unwound').toEqual([
			{ kind: 'reject', feedback: 'User interrupted.' },
		])
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
	})

	it('disturbs nothing when the conversation cannot be read', async () => {
		// The abort, the transcript reset and the scope switch all happen AFTER
		// the read succeeds, deliberately: a resume that cannot be completed must
		// leave a running turn running where it belongs, exactly as cancelling the
		// picker does. Ordering is the whole of it, so it is asserted rather than
		// left to the order the lines happen to be in.
		loadShouldFail = true
		const harness = await pickerOpenMidTurn()

		harness.stdin.write('\r')
		await untilFrame(harness, 'DISKUNREADABLE', 'the failure was never reported')

		gates[0]?.release()
		await appendsReach(1)
		await tick(120)

		expect(abortSeenAtRelease, 'a failed resume aborted the turn anyway').toBe(false)
		const everything = said(harness)
		expect(everything, 'the turn stopped rendering into its own transcript').toContain('LEAKEDREPLY0')
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
	})

	it('leaves the running turn alone when the picker is cancelled', async () => {
		const harness = await pickerOpenMidTurn()

		harness.stdin.write('\x1B')
		await tick(80)
		expect(harness.lastFrame(), 'cancelling the picker resumed something').not.toContain(
			'RESTOREDANSWER',
		)

		gates[0]?.release()
		await appendsReach(1)
		await tick(120)

		expect(abortSeenAtRelease, 'cancelling the picker aborted the turn').toBe(false)
		const everything = said(harness)
		expect(everything, 'the turn stopped rendering into its own transcript').toContain('LEAKEDREPLY0')
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
	})
})
