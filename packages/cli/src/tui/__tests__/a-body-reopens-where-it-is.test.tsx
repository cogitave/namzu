/**
 * The expand key reopens a body where it already is.
 *
 * ## What it could not do before, and how that was established
 *
 * Every finalized row went through `<Static>`, which prints a row once and
 * never redraws it. So the key advertised on every collapsed body could not
 * reach the body: measured with a twelve-line body up, pressing it produced one
 * further frame whose transcript region was byte-identical to the previous one.
 * That is why expansion had to become a command appending a second copy of the
 * output further down.
 *
 * The rows at the end of the transcript are now drawn live, so for those the
 * key does what it always claimed.
 *
 * ## Why this is on the screen surface
 *
 * A frame string cannot tell "printed again below" from "rewritten in place",
 * and that distinction is the whole of this change. The emulated terminal can:
 * the row that showed the hint is asked what it shows now, an anchor above it
 * is asked whether it moved, and the buffer is asked how many copies of the
 * body it holds. An assertion that the hidden lines are "visible somewhere"
 * would pass for the appending command that already exists.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

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

/** Twelve lines: six print, six hide behind the hint. */
const RESULT_DETAIL = Array.from({ length: 12 }, (_, i) => `result-line-${i + 1}`)

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
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'tool-start', toolUseId: 'u1', toolName: 'bash', summary: 'ls' } as AgentEvent
				yield {
					kind: 'tool-end',
					toolUseId: 'u1',
					toolName: 'bash',
					summary: 'ok',
					isError: false,
					durationMs: 3_041,
					detail: RESULT_DETAIL,
				} as AgentEvent
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }

/** Tall enough that expansion fits without scrolling under the row assertion. */
const COLS = 100
const ROWS = 60

const mounted: Screen[] = []

afterEach(async () => {
	for (const screen of mounted) await screen.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

/** Poll rather than sleep: this suite transforms TypeScript on the way in, and
 *  a fixed wait that passes alone goes red inside the full parallel run. */
async function screenShows(screen: Screen, text: string, timeoutMs = 8_000): Promise<void> {
	const started = performance.now()
	while (performance.now() - started < timeoutMs) {
		await screen.waitForRender()
		if (screen.viewport().some((line) => line.includes(text))) return
		await new Promise((resolve) => setTimeout(resolve, 20))
	}
}

/** Index of the viewport row containing `text`, or -1. */
function rowOf(screen: Screen, text: string): number {
	return screen.viewport().findIndex((line) => line.includes(text))
}

/** Render, run the turn, and stop with one collapsed twelve-line body on screen. */
async function aCollapsedBody(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: COLS, rows: ROWS, scrollback: 400 })
	mounted.push(screen)
	// The composer's placeholder draws from the first frame while the composer
	// is still disabled, so it is not readiness. The connect line only exists
	// once the session is up.
	await screenShows(screen, 'Connected to a-provider')
	screen.press('go')
	await screen.waitForRender()
	screen.press('\r')
	await screenShows(screen, 'result-line-6')
	expect(screen.viewport().join('\n'), 'the turn never produced output').toContain('result-line-6')
	return screen
}

describe('the expand key, on a body that is still on screen', () => {
	it('opens it where it is, rather than printing a second copy below', async () => {
		const screen = await aCollapsedBody()

		const before = screen.viewport().join('\n')
		expect(before, 'the body was not collapsed to begin with').toContain('… +6 lines')
		expect(before, 'the hidden lines were visible before the key was pressed').not.toContain(
			'result-line-7',
		)
		const hintRow = rowOf(screen, '… +6 lines')
		const anchorRow = rowOf(screen, 'result-line-1')
		expect(hintRow, 'the hint is not on screen').toBeGreaterThan(-1)

		screen.press('\x0f') // Ctrl+O
		await screenShows(screen, 'result-line-7')

		// The rows above did not move, so the row indexes below mean something.
		// If this fails the viewport scrolled, and the test says so rather than
		// quietly asserting about a different row.
		expect(rowOf(screen, 'result-line-1'), 'the viewport scrolled under the assertion').toBe(
			anchorRow,
		)
		// The row that carried the hint now carries the seventh line of the body.
		// This is the assertion a frame string cannot make.
		expect(
			screen.row(hintRow),
			'the row that advertised the hidden lines is not the row that now shows them',
		).toContain('result-line-7')
		// And the hint is gone rather than still sitting above a copy.
		expect(screen.viewport().join('\n'), 'the collapsed row was left behind').not.toContain(
			'… +6 lines',
		)
		// One copy of the body on screen, not two. An appended expansion leaves
		// the collapsed rows above its copy and would satisfy every "the hidden
		// lines are visible somewhere" assertion.
		//
		// Read from the viewport rather than the whole buffer: a terminal that
		// has scrolled keeps the frames that scrolled off, and those are the
		// operator's history rather than the screen they are looking at.
		//
		// `endsWith`, because `result-line-1` is a prefix of `result-line-12` and
		// a substring match counts the same body four times.
		const copies = screen.viewport().filter((line) => line.endsWith('result-line-1'))
		expect(copies, 'the body was printed a second time instead of reopened').toHaveLength(1)
	}, 30_000)

	it('keeps the composer contiguous with a short transcript on a tall terminal', async () => {
		const screen = await aCollapsedBody()

		const viewport = screen.viewport()
		const composer = viewport.findIndex((line) => line.includes('Type a message'))
		const lastTranscript = viewport.findIndex((line) => line.includes('… +6 lines'))
		expect(composer, 'the composer is not on screen').toBeGreaterThan(-1)
		expect(lastTranscript, 'the transcript tail is not on screen').toBeGreaterThan(-1)
		expect(
			composer - lastTranscript,
			'the layout inserted viewport-scaled dead space before the composer',
		).toBeLessThanOrEqual(4)
	}, 30_000)

	it('renders the measured tool duration carried by the run event', async () => {
		const screen = await aCollapsedBody()

		expect(screen.viewport().join('\n')).toContain('✓ Bash(ls) · 3.0s')
	}, 30_000)

	it('keeps one transcript and a usable composer through tall-short-tall resize', async () => {
		const screen = await aCollapsedBody()
		const call = (line: string) => line.includes('✓ Bash(ls)')

		await screen.resize(72, 20)
		expect(screen.bufferType()).toBe('normal')
		expect(screen.viewport().join('\n')).toContain('Type a message')

		await screen.resize(COLS, 50)
		expect(screen.viewport().join('\n')).toContain('Type a message')
		expect(screen.scrollback().filter(call), 'resize printed a second durable tool row').toHaveLength(1)
	}, 30_000)

	it('still reaches the rows of the conversation after /clear-screen', async () => {
		// `/clear-screen` empties the transcript and remounts the static log, and the
		// window has to come back with it.
		//
		// Honest about what this does NOT pin: dropping `settledRef` in
		// `resetTranscript` leaves this green — verified by mutation. A stale
		// floor is self-correcting, because it is clamped to the transcript's
		// length and the window reopens as the new conversation grows past it,
		// and this fixture's second conversation is already longer than the
		// floor the first one left. What it does pin is the outcome an operator
		// would notice: the key still reaches a body after the screen has been
		// cleared under it.
		const screen = await aCollapsedBody()

		screen.press('/clear-screen')
		await screen.waitForRender()
		screen.press('\r')
		await screenShows(screen, 'Type a message')
		expect(screen.viewport().join('\n'), 'the transcript was not cleared').not.toContain(
			'result-line-6',
		)

		screen.press('go')
		await screen.waitForRender()
		screen.press('\r')
		await screenShows(screen, 'result-line-6')

		screen.press('\x0f')
		await screenShows(screen, 'result-line-7')
		expect(
			screen.viewport().join('\n'),
			'the key stopped reaching anything once the transcript had been cleared',
		).toContain('result-line-7')
	}, 30_000)

	it('closes it again, because it is a toggle', async () => {
		const screen = await aCollapsedBody()

		screen.press('\x0f')
		await screenShows(screen, 'result-line-7')
		screen.press('\x0f')
		await screenShows(screen, '… +6 lines')

		const frame = screen.viewport().join('\n')
		expect(frame, 'the key only ever opened').toContain('… +6 lines')
		expect(frame, 'the body stayed open').not.toContain('result-line-7')
	}, 30_000)
})
