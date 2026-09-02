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
 * Either way the expansion has to be a NEW row, which is what Ctrl+O pushes
 * once the body has scrolled out of the redrawable window.
 * These tests are written against that distinction: the assertion is not "the
 * hidden lines are visible somewhere" but "a new row appeared containing them,
 * and the collapsed one is untouched", because the first would also pass for a
 * design that cannot reach the case anyone actually hits.
 *
 * Driven through a rendered `<App>` rather than `<Transcript>` alone, because
 * every part of this that can go wrong lives in the seam: whether the hint names
 * the key that works, and whether the key reaches a transcript that is still
 * being written to. A component test sees neither.
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
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

/**
 * Twelve lines, so six collapse and six hide. Distinguishable per line and
 * per block: an assertion that `line-9` reached the screen must not be
 * satisfiable by the OTHER block's ninth line, or the test would pass while
 * the wrong block was reprinted.
 */
const CALL_DETAIL = Array.from({ length: 12 }, (_, i) => `call-line-${i + 1}`)
const RESULT_DETAIL = Array.from({ length: 12 }, (_, i) => `result-line-${i + 1}`)

/**
 * Short enough to print in full, so it collapses nothing and advertises nothing.
 *
 * Three lines rather than seven on purpose: the whole question is whether a body
 * that never truncates can nonetheless be the one Ctrl+O reprints. Set by the
 * second `describe` below.
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


describe('a collapsed body advertises how to read it', () => {
	it('names the key, and nothing else', async () => {
		const { lastFrame } = await twoCollapsedBlocks()

		const frame = lastFrame() ?? ''
		// Both blocks hide six lines, and each points at the same key.
		expect(frame.split('… +6 lines · ctrl+o').length - 1, 'both bodies name the key').toBe(2)
		// The command this replaced must not still be advertised anywhere.
		expect(frame, 'a removed command is still advertised').not.toContain('/expand')
	})
})

/** Run `fn` on a terminal too short to keep any transcript row redrawable. */
async function onAShortTerminal<T>(fn: () => Promise<T>): Promise<T> {
	const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows')
	Object.defineProperty(process.stdout, 'rows', { value: 16, configurable: true })
	try {
		return await fn()
	} finally {
		if (rows) Object.defineProperty(process.stdout, 'rows', rows)
		else Reflect.deleteProperty(process.stdout, 'rows')
	}
}

describe('a body that fits', () => {
	it('is not what Ctrl+O reprints; the hidden one is', async () => {
		// The turn ends with a three-line body: fully visible, no hint, nothing
		// concealed. Treating it as "the most recent block" would reprint three
		// lines the operator can already read while the twelve-line body above
		// stayed truncated — an answer to a question nobody asked.
		trailingShortBlock = true
		await onAShortTerminal(async () => {
			const harness = render(<App ctx={ctx} />)
			mounted.push(harness)
			await frameShows(harness.lastFrame, 'Connected to a-provider')
			harness.stdin.write('go')
			await tick(20)
			harness.stdin.write('\r')
			await frameShows(harness.lastFrame, 'short-c')

			harness.stdin.write('\x0f') // Ctrl+O
			await frameShows(harness.lastFrame, 'result-line-12')

			expect(
				harness.lastFrame() ?? '',
				'Ctrl+O reprinted a body that was already whole',
			).toContain('result-line-12')
		})
	})
})

describe('Ctrl+O', () => {
	// Opening in place while a row is still redrawable is covered by
	// `a-body-reopens-where-it-is` on a real PTY; this harness keeps no row
	// redrawable, so every press here takes the reprint path.

	it('reprints the most recent body as a NEW row once the rows have scrolled away', async () => {
		// Rows printed to the terminal's own scrollback cannot be rewritten, so
		// on a terminal too short to keep one redrawable the key appends a copy
		// that says what it is of — and leaves the collapsed row exactly as it
		// was, which is the assertion that separates emitting from mutating.
		await onAShortTerminal(async () => {
			const harness = await twoCollapsedBlocks()

			harness.stdin.write('\x0f')
			await frameShows(harness.lastFrame, 'result-line-12')

			const frame = harness.lastFrame() ?? ''
			expect(frame, 'the hidden lines never appeared').toContain('result-line-12')
			expect(frame, 'the reprint did not say what it is of').toContain('in full (12 lines)')
			expect(frame, 'the most recent body is the one reprinted').not.toContain('call-line-12')
		})
	})

	it('says what produces one when the transcript has none', async () => {
		// Before any tool has run. An empty result here would read as a broken
		// key rather than as an empty set.
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		// The COMPOSER's placeholder is not readiness — it draws from the first
		// frame, while the composer stays `disabled` until the session is up. The
		// connect line is the first thing that only exists once `phase === 'ready'`.
		await frameShows(harness.lastFrame, 'Connected to a-provider')

		harness.stdin.write('\x0f')
		await frameShows(harness.lastFrame, 'Nothing to expand yet')

		expect(harness.lastFrame() ?? '').toContain('Nothing to expand yet')
	})

	it('forgets a body when Ctrl+L takes the rows away', async () => {
		// A body outliving the row it was in would print output the operator
		// can no longer see anywhere, from a transcript they just cleared.
		const harness = await twoCollapsedBlocks()

		harness.stdin.write('\x0c') // Ctrl+L
		await tick(80)
		harness.stdin.write('\x0f')
		await frameShows(harness.lastFrame, 'Nothing to expand yet')

		const frame = harness.lastFrame() ?? ''
		expect(frame, 'a cleared block was still expandable').toContain('Nothing to expand yet')
		expect(frame, 'output from a cleared transcript came back').not.toContain('call-line-12')
	})
})
