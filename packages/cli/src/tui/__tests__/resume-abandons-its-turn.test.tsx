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
 *   3. its record landed in the RESUMED conversation's durable log, because
 *      `sessionId` was mutated on a `SessionScope` the running loop held the
 *      same object of. That one outlived the process.
 *
 * The kernel's turn recorder writes a turn, not App: the fake session below
 * records into the conversation it read from its scope when the turn began,
 * as the real session does, so half 3 is the session keeping that copy.
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
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, SessionScope } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** The conversation the turn is started in, and the one `/resume` moves to. */
const STARTED_IN = 'conv-started-in'
const RESUMED = 'conv-resumed'

/** Every turn the fake kernel recorded, with the conversation it recorded into. */
const appended: Array<{ sessionId: string; contents: string[] }> = []
/** The scope App handed the session; the fake copies its id when a turn begins. */
let sessionScope: SessionScope | undefined
/** Number of recorded turns visible each time `/fork` takes its snapshot. */
const forkedAfterAppends: number[] = []
/** Compaction model calls — none may start against an unsettled snapshot. */
let compactCalls = 0

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
/** Held by a test that needs the turn's record started but not yet landed. */
let appendHeld: Promise<void> | null = null
let releaseTheAppend: () => void = () => {}
function holdTheAppend(): void {
	appendHeld = new Promise<void>((resolve) => {
		releaseTheAppend = resolve
	})
}
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
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({
		tenantId: 't',
		root: '/tmp/.namzu',
	}),
	startConversation: async () => STARTED_IN,
	requireWritableConversation: async () => {},
	listRecent: async () => [
		{
			id: RESUMED,
			title: 'An earlier conversation',
			updatedAt: new Date().toISOString(),
			count: 2,
		},
	],
	loadConversation: async () => {
		if (readHeld) await readHeld
		if (loadShouldFail) throw new Error('DISKUNREADABLE')
		return [
			{ role: 'user', content: 'RESTOREDQUESTION', timestamp: 1 },
			{ role: 'assistant', content: 'RESTOREDANSWER', timestamp: 2 },
		]
	},
	forkConversation: async () => {
		forkedAfterAppends.push(appended.length)
		return { id: 'conv-forked', title: 'the fork', copied: 2 }
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
		createAgentSession: async (
			_preferences: unknown,
			_detected: unknown,
			options: { readonly scope?: SessionScope },
		): Promise<AgentSession> => {
			sessionScope = options.scope
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => {
					compactCalls += 1
					return null
				},
				providerSummary: 'a-provider',
				modelSummary: 'a-model',
				toolNames: () => ['bash'],
				presenter: genericPresenter,
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
				// The TUI never resumes a durable turn; a stub that answered would make
				// a resume look reachable from here.
				resumeDurable: async () => {
					throw new Error('not used by the TUI')
				},
				resumePaused: () => {
					throw new Error('resumePaused is not part of this test')
				},
				close: async () => {},
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
					// Copied when the turn begins, as the real session copies its scope:
					// the turn is recorded there however the scope moves afterwards.
					const recordInto = sessionScope?.sessionId ?? 'no-scope'
					const said: string[] = []
					try {
						yield* turnEvents(turn, gate, opts, said)
					} finally {
						// The recorder settles every turn — completed, cancelled or failed.
						appended.push({ sessionId: recordInto, contents: said })
						if (appendHeld) await appendHeld
					}
				},
			}
		},
	}
})

async function* turnEvents(
	turn: number,
	gate: { wait: Promise<void> },
	opts: Parameters<AgentSession['send']>[1],
	said: string[],
): AsyncIterable<AgentEvent> {
	const yielded = (event: AgentEvent): AgentEvent => {
		if (event.kind === 'delta') said.push(event.text)
		return event
	}
	// A delta BEFORE the wait, so the turn owns a streaming assistant row
	// in the transcript that `/resume` then throws away. That is the shape
	// where a late `appendToMessage` would target an id belonging to the
	// discarded array and no-op in silence — invisible to a turn whose
	// first event is a tool call.
	yield yielded({ kind: 'delta', text: `EARLY${turn} ` } as AgentEvent)
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
			toolCalls: [
				{
					id: 'call-1',
					name: 'bash',
					input: { command: 'rm -rf build' },
					isDestructive: true,
				},
			],
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
	yield yielded({ kind: 'delta', text: `LEAKEDREPLY${turn}` } as AgentEvent)
	if (throwAtEnd && turn === 0) throw new Error('TURNBLEWUP')
	yield { kind: 'done' } as AgentEvent
}

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: process.cwd(), version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	appended.length = 0
	forkedAfterAppends.length = 0
	compactCalls = 0
	gates.length = 0
	signals.length = 0
	abortSeenAtRelease = false
	loadShouldFail = false
	appendHeld = null
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
	releaseTheAppend()
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
	await vi.waitFor(() => expect(harness.lastFrame(), why).toContain(needle))
}

/**
 * Render, run a turn until it parks on the gate, type `/resume` into it (which
 * waits for the reply instead of running), end the reply, and wait for the
 * picker the queued command opens.
 *
 * Polled rather than slept through, for the reason `app-permission-keys`
 * documents: a fixed wait passes this file alone and fails under the full
 * parallel run, and the failure is reported as whatever the test was about.
 */
async function pickerOpenAfterTurn(
	afterQueued?: (harness: ReturnType<typeof render>) => Promise<void>,
) {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await tick(60)
	await submit(harness, 'go')
	await submit(harness, '/resume')
	await afterQueued?.(harness)
	expect(harness.lastFrame(), '/resume ran over the reply').not.toContain('Resume a conversation')
	expect(abortSeenAtRelease, '/resume stopped the reply').toBe(false)
	gates[0]?.release()
	await appendsReach(1)
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

/** Type and deliberately address the next-turn queue. */
async function queue(harness: { stdin: { write: (s: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\t')
	await tick(60)
}

/** Wait until `n` turns have persisted themselves. */
async function appendsReach(n: number, timeoutMs?: number): Promise<void> {
	await vi.waitFor(() => expect(appended.length).toBeGreaterThanOrEqual(n), timeoutMs)
}

describe('/resume typed while a turn is running', () => {
	it('waits for the reply to end, then opens the picker, and saves the reply where it started', async () => {
		const harness = await pickerOpenAfterTurn()
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
		expect(said(harness)).toContain('LEAKEDREPLY0')
		expect(abortSeenAtRelease, 'the reply was stopped').toBe(false)
	})

	it('adds the restored operator prompt to live composer history', async () => {
		const harness = await pickerOpenAfterTurn()

		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the selected conversation never opened')
		harness.stdin.write('\x12')
		await untilFrame(
			harness,
			'RESTOREDQUESTION▏',
			'the restored operator prompt never entered composer history',
		)
	})

	it('keeps the picker until the conversation is actually read', async () => {
		// The composer is live in the `ready` phase, and handing it back before the
		// read settles gives a message nowhere to go. Esc stops cancelling for the
		// same interval: the choice is already being acted on.
		holdTheRead()
		const harness = await pickerOpenAfterTurn()

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

	it('does not send a message queued behind it into the conversation it lands in', async () => {
		// A message typed after `/resume` was meant for the conversation being
		// left; choosing another one drops it, and says so.
		const harness = await pickerOpenAfterTurn(async (h) => {
			await queue(h, 'FOLLOWUP')
			await untilFrame(h, '❯ FOLLOWUP · after this reply', 'the follow-up was not queued')
		})
		await tick(100)
		expect(gates.length, 'the follow-up ran behind the open picker').toBe(1)

		harness.stdin.write('\r')
		await untilFrame(harness, 'RESTOREDANSWER', 'the conversation never loaded')
		await untilFrame(
			harness,
			'Discarded 1 queued prompt',
			'the dropped prompt was not accounted for',
		)
		await tick(200)

		expect(gates.length, 'the queued follow-up ran in the resumed conversation').toBe(1)
		expect(appended.map((entry) => entry.sessionId)).toEqual([STARTED_IN])
	})

	it('disturbs nothing when the conversation cannot be read', async () => {
		loadShouldFail = true
		const harness = await pickerOpenAfterTurn()

		harness.stdin.write('\r')
		await untilFrame(
			harness,
			'Could not resume that conversation.',
			'the failure was never reported',
		)
		expect(said(harness)).toContain('LEAKEDREPLY0')
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
	})

	it('leaves everything alone when the picker is cancelled', async () => {
		const harness = await pickerOpenAfterTurn()

		harness.stdin.write('\x1B')
		await tick(80)
		expect(harness.lastFrame(), 'cancelling the picker resumed something').not.toContain(
			'RESTOREDANSWER',
		)
		expect(said(harness)).toContain('LEAKEDREPLY0')
		expect(appended.map((a) => a.sessionId)).toEqual([STARTED_IN])
	})
})

describe('/fork after an interrupted turn', () => {
	it('waits until the old iterator has finished and its turn is recorded', async () => {
		// `Esc` hands the screen back immediately. The provider iterator is still
		// parked on `gate.wait`, so the kernel has not recorded this turn yet.
		// Forking in this window would copy history without it.
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await tick(60)
		await submit(harness, 'the prompt being interrupted')
		await untilFrame(harness, 'RUNNING0', 'the turn never reached its held tool')

		harness.stdin.write('\x1B')
		await untilFrame(harness, 'Interrupted', 'Esc did not hand the screen back')
		// Typed while the stopped turn is still being saved, `/fork` waits as typed
		// instead of copying a conversation that lacks that turn.
		await submit(harness, '/fork')
		expect(
			forkedAfterAppends,
			'fork reached the store before the interrupted iterator scheduled its append',
		).toEqual([])

		// While the old turn is still being recorded its iterator has not
		// finished, so the queued `/fork` still waits: the store cannot observe a
		// snapshot from before the turn the operator just watched.
		holdTheAppend()
		gates[0]?.release()
		await appendsReach(1)
		await tick(120)
		expect(
			forkedAfterAppends,
			'fork took its snapshot while the interrupted turn was still being recorded',
		).toEqual([])

		releaseTheAppend()
		await vi.waitFor(() => expect(forkedAfterAppends.length).toBeGreaterThan(0))

		expect(forkedAfterAppends).toEqual([1])
		expect(appended[0]?.contents.join(' ')).toContain('LEAKEDREPLY0')
	})
})
