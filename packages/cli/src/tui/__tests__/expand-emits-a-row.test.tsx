/**
 * Collapsed tool output can be read in full, and the way it advertises works.
 *
 * Finalized rows render through Ink's `<Static>`, which keeps an index of what
 * it has already emitted, renders `items.slice(index)`, and calls the render
 * function only for items beyond it. So the key this replaces could not reopen
 * a body already on screen — measured, with a twelve-line body up: pressing it
 * produced one further frame whose transcript region was byte-identical.
 *
 * It was not inert, though, and getting that wrong is what shaped this file.
 * `<Static>` calls the CURRENT render closure for each newly appended item, so
 * pressing the key while a tool was still running made that tool's result print
 * in full when it arrived — a real behaviour, invisible, and available only to
 * someone who wanted the output before knowing it would be truncated.
 *
 * Either way the expansion has to be a NEW row, which is what `/expand` pushes.
 * These tests are written against that distinction: the assertion is not "the
 * hidden lines are visible somewhere" but "a new row appeared containing them,
 * and the collapsed one is untouched", because the first would also pass for a
 * design that cannot reach the case anyone actually hits.
 *
 * Driven through a rendered `<App>` rather than `<Transcript>` alone, because
 * every part of this that can go wrong lives in the seam: whether the number in
 * the hint is the number the command takes, and whether the command reaches a
 * transcript that is still being written to. A component test sees neither.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

/**
 * Twelve lines, so six collapse and six hide. Distinguishable per line and
 * per block: an assertion that `line-9` reached the screen must not be
 * satisfiable by the OTHER block's ninth line, or the test would pass while
 * `/expand 1` expanded block 2.
 */
const CALL_DETAIL = Array.from({ length: 12 }, (_, i) => `call-line-${i + 1}`)
const RESULT_DETAIL = Array.from({ length: 12 }, (_, i) => `result-line-${i + 1}`)

/**
 * Short enough to print in full, so it collapses nothing and advertises nothing.
 *
 * Three lines rather than seven on purpose: the whole question is whether a body
 * that never truncates can nonetheless take a number and be picked up by a bare
 * `/expand`. Set by the second `describe` below.
 */
const SHORT_DETAIL = ['short-a', 'short-b', 'short-c']
/** Whether the mocked turn ends with a short, uncollapsed body. */
let trailingShortBlock = false

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
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
			errorHint: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			// One tool call producing TWO collapsible bodies — the `⏺` call line
			// and the `⎿` result. Two is the minimum that can tell a working
			// lookup from one that always returns the last thing it saw.
			send: async function* (): AsyncIterable<AgentEvent> {
				yield {
					kind: 'tool-start',
					toolUseId: 'u1',
					toolName: 'bash',
					summary: 'ls',
					detail: CALL_DETAIL,
				} as AgentEvent
				await new Promise((r) => setTimeout(r, 10))
				yield {
					kind: 'tool-end',
					toolUseId: 'u1',
					toolName: 'bash',
					summary: 'ok',
					isError: false,
					detail: RESULT_DETAIL,
				} as AgentEvent
				if (trailingShortBlock) {
					yield {
						kind: 'tool-start',
						toolUseId: 'u2',
						toolName: 'read',
						summary: 'notes.txt',
						detail: SHORT_DETAIL,
					} as AgentEvent
					await new Promise((r) => setTimeout(r, 10))
					yield {
						kind: 'tool-end',
						toolUseId: 'u2',
						toolName: 'read',
						summary: 'ok',
						isError: false,
						detail: SHORT_DETAIL,
					} as AgentEvent
				}
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	trailingShortBlock = false
	vi.restoreAllMocks()
})

/**
 * Poll rather than sleep a fixed interval.
 *
 * The same load cliff the permission-key harness documents: this suite
 * transforms TypeScript on the way in, and a fixed wait that passes this file
 * alone goes red inside the full parallel run — reported as "the output never
 * arrived" rather than as whatever the test was about.
 */
async function frameShows(
	lastFrame: () => string | undefined,
	text: string,
	timeoutMs = 5_000,
): Promise<void> {
	const started = performance.now()
	while (!(lastFrame() ?? '').includes(text) && performance.now() - started < timeoutMs) {
		await tick(20)
	}
}

/** Render, run the turn, and stop with two collapsed bodies on screen. */
async function twoCollapsedBlocks() {
	const harness = render(<App ctx={ctx} />)
	// Registered before the first assertion so a throw still tears down; a
	// leaked Ink instance turns one real failure into a column of fake ones.
	mounted.push(harness)
	// The COMPOSER's placeholder is not readiness — it draws from the first
	// frame, while the composer stays `disabled` until the session is up, so a
	// key sent on sight of it is dropped and the turn never runs. The connect
	// line is the first thing that only exists once `phase === 'ready'`.
	await frameShows(harness.lastFrame, 'Connected to a-provider')
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	await frameShows(harness.lastFrame, 'result-line-6')
	expect(harness.lastFrame(), 'the turn never produced output').toContain('result-line-6')
	return harness
}

/**
 * The longest run of consecutive blank lines in a frame.
 *
 * The bottom spacer is a `<Box height={n} />` and renders as exactly that: n
 * empty rows above the composer. Nothing else in the layout produces a run of
 * them, so this is how much padding was inserted.
 */
function longestBlankRun(frame: string): number {
	let best = 0
	let run = 0
	for (const line of frame.split('\n')) {
		run = line.trim().length === 0 ? run + 1 : 0
		if (run > best) best = run
	}
	return best
}

/** Type a line into the composer and submit it. */
async function submit(harness: { stdin: { write: (s: string) => void } }, line: string) {
	// Written separately: Ink delivers one `stdin.write` as ONE keypress, so
	// `'/expand\r'` arrives with `key.return` false and is taken as pasted text.
	harness.stdin.write(line)
	await tick(30)
	harness.stdin.write('\r')
}

describe('a collapsed body advertises how to read it', () => {
	it('names the number the command takes, rather than a key', async () => {
		const { lastFrame } = await twoCollapsedBlocks()

		const frame = lastFrame() ?? ''
		// Both blocks hide six lines, and each carries its own number.
		expect(frame, 'the first body did not name itself').toContain('… +6 lines · /expand 1')
		expect(frame, 'the second body did not name itself').toContain('… +6 lines · /expand 2')
		// The removed key must not still be advertised anywhere on the screen.
		// A key that is gone and still printed is the defect this replaced.
		expect(frame.toLowerCase(), 'a removed key is still advertised').not.toContain('ctrl+o')
	})
})

describe('a body that fits', () => {
	it('takes no number, so bare /expand still reaches the one that is hidden', async () => {
		// The turn ends with a three-line body: fully visible, no hint, nothing
		// concealed. Numbering it anyway would make it "the most recent block",
		// so bare `/expand` would reprint three lines the operator can already
		// read while the twelve-line body above stayed truncated — a command that
		// answers a question nobody asked and leaves the real one unanswered.
		//
		// It also puts invisible gaps in the sequence, and makes "this
		// conversation has N" count blocks no hint ever offered.
		trailingShortBlock = true
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Connected to a-provider')
		harness.stdin.write('go')
		await tick(20)
		harness.stdin.write('\r')
		await frameShows(harness.lastFrame, 'short-c')

		const before = harness.lastFrame() ?? ''
		// Two numbered blocks, and they are the two that truncated.
		expect(before).toContain('… +6 lines · /expand 1')
		expect(before).toContain('… +6 lines · /expand 2')
		expect(before, 'a body that fits was numbered').not.toContain('/expand 3')

		await submit(harness, '/expand')
		await frameShows(harness.lastFrame, 'result-line-12')

		expect(
			harness.lastFrame() ?? '',
			'bare /expand reprinted a body that was already whole',
		).toContain('result-line-12')
	})
})

describe('Ctrl+O, which used to be the way', () => {
	it('is still bound, and says what to press instead', async () => {
		// It is not deleted out from under anyone. Advertised for a long time as
		// toggling full expansion, it never could reopen output already drawn —
		// but it was not inert either: it pre-armed rows that had not arrived yet.
		// So it keeps answering, and what it answers is the replacement.
		const harness = await twoCollapsedBlocks()

		harness.stdin.write('\x0f') // Ctrl+O
		await frameShows(harness.lastFrame, 'Ctrl+O is deprecated')

		const frame = harness.lastFrame() ?? ''
		expect(frame, 'the key went back to being silent').toContain('Ctrl+O is deprecated')
		expect(frame, 'said it was gone without saying what replaced it').toContain('/expand')
		// And it must not have expanded anything: the whole point is that it
		// cannot, and a notice plus a silent expansion would be two answers.
		expect(frame, 'the deprecated key expanded something anyway').not.toContain('result-line-12')
	})
})

describe('/expand', () => {
	it('prints the hidden lines as a NEW row, leaving the collapsed one alone', async () => {
		const harness = await twoCollapsedBlocks()

		await submit(harness, '/expand 2')
		await frameShows(harness.lastFrame, 'result-line-12')

		const frame = harness.lastFrame() ?? ''
		// The lines that were behind the hint are now on screen.
		expect(frame, 'the hidden lines never appeared').toContain('result-line-12')
		// And they arrived as a new row that says what it is of, rather than by
		// the old row changing — which `<Static>` would not have allowed.
		expect(frame, 'the expansion did not say what it expanded').toContain('in full (12 lines)')
		// The original row still reads exactly as it did. This is the assertion
		// that distinguishes emitting from mutating: a design that tried to
		// re-render the committed row would leave no hint behind.
		expect(frame, 'the collapsed row was disturbed').toContain('… +6 lines · /expand 2')
	})

	it('takes the number the hint printed, not the position of the row', async () => {
		// `/expand 1` must reach the FIRST body. Between the two bodies sit the
		// user's own row and the tool result line, so anything counting messages
		// rather than bodies lands somewhere else.
		const harness = await twoCollapsedBlocks()

		await submit(harness, '/expand 1')
		await frameShows(harness.lastFrame, 'call-line-12')

		const frame = harness.lastFrame() ?? ''
		expect(frame, '/expand 1 did not reach the first body').toContain('call-line-12')
		expect(frame, '/expand 1 expanded the wrong body').not.toContain('result-line-12')
	})

	it('with no argument takes the most recent body', async () => {
		const harness = await twoCollapsedBlocks()

		await submit(harness, '/expand')
		await frameShows(harness.lastFrame, 'result-line-12')

		const frame = harness.lastFrame() ?? ''
		expect(frame, 'bare /expand did not take the most recent').toContain('result-line-12')
		expect(frame, 'bare /expand reached back past the most recent').not.toContain('call-line-12')
	})

	it('says how many there are when asked for one that does not exist', async () => {
		// Refusing alone would leave the operator guessing at a number, which is
		// the same cost the numbered hint exists to remove.
		const harness = await twoCollapsedBlocks()

		await submit(harness, '/expand 9')
		await frameShows(harness.lastFrame, 'No collapsed output numbered 9')

		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('No collapsed output numbered 9')
		expect(frame, 'refused without saying which numbers exist').toContain('numbered 1 to 2')
	})

	it('says what produces one when the transcript has none', async () => {
		// Before any tool has run. An empty result here would read as a broken
		// command rather than as an empty set.
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		// The COMPOSER's placeholder is not readiness — it draws from the first
	// frame, while the composer stays `disabled` until the session is up, so a
	// key sent on sight of it is dropped and the turn never runs. The connect
	// line is the first thing that only exists once `phase === 'ready'`.
	await frameShows(harness.lastFrame, 'Connected to a-provider')

		await submit(harness, '/expand')
		await frameShows(harness.lastFrame, 'Nothing to expand yet')

		expect(harness.lastFrame() ?? '').toContain('Nothing to expand yet')
	})

	it('forgets the numbers when /clear takes the rows away', async () => {
		// A number outliving the row it names is this surface's own defect in
		// miniature: `/expand 1` would print output the operator can no longer
		// see anywhere, from a conversation they just cleared.
		const harness = await twoCollapsedBlocks()

		await submit(harness, '/clear')
		await tick(80)
		await submit(harness, '/expand 1')
		await frameShows(harness.lastFrame, 'Nothing to expand yet')

		const frame = harness.lastFrame() ?? ''
		expect(frame, 'a cleared block was still expandable').toContain('Nothing to expand yet')
		expect(frame, 'output from a cleared conversation came back').not.toContain('call-line-12')
	})

	it('stops padding the composer down once the expansion fills the viewport', async () => {
		// The wiring assertion, and it has to be here rather than on the helper.
		//
		// `spacerTranscript` has its own unit tests, and every one of them stays
		// green if `App` goes back to passing `messages.map(m => m.content)` — the
		// helper would simply not be called. That is a check that cannot fail
		// under its own target defect, so this drives the real component and
		// looks at the real frame.
		//
		// What it looks at: the spacer pads blank rows above the composer only
		// while the transcript is knowably shorter than the terminal. An expanded
		// twelve-line body on a small terminal is past that point, so the padding
		// must be gone. If App stops counting bodies, the same transcript measures
		// a handful of rows and the spacer pads a screenful — pushing the composer
		// out of view, which is the harm the estimate exists to avoid.
		const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows')
		const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns')
		// Forty rows, not twenty-four, and the difference is the point. At 24 the
		// live furniture and safety margin leave so little budget that the
		// unmeasured transcript ALSO comes out barely padded, and the test passed
		// the defect by three rows. A tall terminal is where the two answers
		// diverge: the real estimate is past the viewport and pads nothing, the
		// content-only one has room to spare and pads a screenful.
		Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true })
		Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
		try {
			const harness = await twoCollapsedBlocks()
			await submit(harness, '/expand 2')
			await frameShows(harness.lastFrame, 'result-line-12')

			const blankRun = longestBlankRun(harness.lastFrame() ?? '')
			expect(blankRun, 'the composer was padded down past a full screen').toBeLessThan(4)
		} finally {
			if (rows) Object.defineProperty(process.stdout, 'rows', rows)
			else Reflect.deleteProperty(process.stdout, 'rows')
			if (columns) Object.defineProperty(process.stdout, 'columns', columns)
			else Reflect.deleteProperty(process.stdout, 'columns')
		}
	})

	it('refuses an argument that is not a number, instead of expanding something', async () => {
		const harness = await twoCollapsedBlocks()

		await submit(harness, '/expand 2nd')
		await frameShows(harness.lastFrame, 'Usage: /expand')

		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('Usage: /expand')
		// `parseInt('2nd')` is 2. A parser that used it would silently expand
		// block 2 for a typo, which is the quiet-wrong-answer failure this
		// whole surface is being cleaned of.
		expect(frame, 'a typo was read as a block number').not.toContain('result-line-12')
	})
})
