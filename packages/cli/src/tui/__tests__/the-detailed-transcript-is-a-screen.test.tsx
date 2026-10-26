/**
 * Ctrl+O opens the detailed transcript on the screen surface.
 *
 * A frame string cannot tell "printed into scrollback" from "drawn in the live
 * region and gone again", and that distinction is the whole of this behaviour:
 * the screen must leave the terminal's own scrollback exactly as it found it.
 * The emulated terminal can be asked how many lines the buffer holds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

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
			presenter: genericPresenter,
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
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
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
 *  a fixed wait that passes alone goes red inside the full parallel run.
 *  `vi.waitFor` inherits this package's test-budget-aware default
 *  (`test-setup.ts`) instead of racing its own fixed wall clock; an explicit
 *  `timeoutMs` is still honoured when a caller passes one. */
async function screenShows(screen: Screen, text: string, timeoutMs?: number): Promise<void> {
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(
			screen.viewport().some((line) => line.includes(text)),
			`screen does not show ${JSON.stringify(text)}`,
		).toBe(true)
	}, timeoutMs)
}

/** Index of the viewport row containing `text`, or -1. */
function rowOf(screen: Screen, text: string): number {
	return screen.viewport().findIndex((line) => line.includes(text))
}

/** Render, run the turn, and stop with one collapsed twelve-line body on screen. */
async function aCollapsedBody(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: COLS,
		rows: ROWS,
		scrollback: 400,
	})
	mounted.push(screen)
	// The composer's placeholder draws from the first frame while the composer
	// is still disabled, so it is not readiness. The model footer only exists
	// once the session is up.
	await screenShows(screen, 'a-model')
	screen.press('go')
	await screen.waitForRender()
	screen.press('\r')
	await screenShows(screen, 'result-line-12')
	expect(screen.viewport().join('\n'), 'the turn never produced output').toContain('result-line-12')
	return screen
}

describe('the detailed transcript, on a body that is folded in the live view', () => {
	it('shows the hidden lines and takes the hint with it', async () => {
		const screen = await aCollapsedBody()
		const before = screen.viewport().join('\n')
		expect(before, 'the body was not collapsed to begin with').toContain('… +6 lines')
		expect(before).not.toContain('result-line-4')

		screen.press('\x0f') // Ctrl+O
		await screenShows(screen, 'Showing detailed transcript')
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('result-line-4')
		expect(frame, 'the screen still points at itself').not.toContain('(ctrl+o to expand)')
		expect(frame, 'the composer is still drawn').not.toContain('Type a message')
	}, 30_000)

	it('writes nothing to scrollback by opening or closing', async () => {
		const screen = await aCollapsedBody()
		await screen.resize(COLS, 18)
		screen.press('draft stays here')
		await screen.waitForRender()
		const before = screen.scrollback().join('\n')
		for (let attempt = 0; attempt < 3; attempt++) {
			screen.press('\x0f')
			await screenShows(screen, 'Showing detailed transcript')
			screen.press(attempt === 1 ? '\x0f' : 'q')
			await screenShows(screen, 'draft stays here')
			expect(screen.viewport().join('\n')).not.toContain('Showing detailed transcript')
		}
		expect(screen.scrollback().join('\n'), 'a copy of the body reached scrollback').toBe(before)
	}, 30_000)

	it('keeps the composer contiguous with a short transcript on a tall terminal', async () => {
		const screen = await aCollapsedBody()

		const viewport = screen.viewport()
		const composer = viewport.findIndex((line) => line.includes('Type a message'))
		const lastTranscript = viewport.findIndex((line) => line.includes('result-line-12'))
		expect(composer, 'the composer is not on screen').toBeGreaterThan(-1)
		expect(lastTranscript, 'the transcript tail is not on screen').toBeGreaterThan(-1)
		expect(
			composer - lastTranscript,
			'the layout inserted viewport-scaled dead space before the composer',
		).toBeLessThanOrEqual(4)
	}, 30_000)

	it('renders the measured tool duration carried by the turn event', async () => {
		const screen = await aCollapsedBody()

		expect(screen.viewport().join('\n')).toContain('● Bash(ls) · 3s')
	}, 30_000)

	it.each([
		[72, 20],
		[COLS, 14],
		[72, ROWS],
	])(
		'keeps one transcript and the draft through resize to %ix%i and back',
		async (cols, rows) => {
			const screen = await aCollapsedBody()
			const call = (line: string) => line.includes('● Bash(ls)')
			screen.press('unsent draft')
			await screen.waitForRender()

			await screen.resize(cols, rows)
			expect(screen.bufferType()).toBe('normal')
			expect(screen.viewport().join('\n')).toContain('unsent draft')

			await screen.resize(COLS, 50)
			expect(screen.viewport().join('\n')).toContain('unsent draft')
			expect(
				screen.scrollback().filter(call),
				'resize printed a second durable tool row',
			).toHaveLength(1)
			expect(
				screen
					.scrollback()
					.filter((line) => line.includes('█▄ █ ▄▀█ █▀▄▀█ ▀█ █ █') || line.includes('∴ namzu')),
			).toHaveLength(1)
			expect(screen.scrollback().join('\n')).toContain('result-line-12')
		},
		30_000,
	)

	it('shows only the new conversation after Ctrl+L', async () => {
		// Ctrl+L empties the transcript; the screen opened afterwards must not
		// bring the cleared rows back.
		const screen = await aCollapsedBody()

		screen.press('\x0c')
		await screenShows(screen, 'Type a message')
		expect(screen.viewport().join('\n'), 'the transcript was not cleared').not.toContain(
			'result-line-12',
		)

		screen.press('\x0f')
		await screenShows(screen, 'Showing detailed transcript')
		expect(screen.viewport().join('\n'), 'a cleared body came back').not.toContain('result-line-12')
	}, 30_000)

	it('stays up while the terminal grows', async () => {
		const screen = await aCollapsedBody()
		await screen.resize(COLS, 18)
		screen.press('\x0f')
		await screenShows(screen, 'Showing detailed transcript')

		await screen.resize(160, 30)
		await screenShows(screen, 'Showing detailed transcript')
		expect(screen.viewport().join('\n')).toContain('result-line-12')
		expect(screen.bufferType()).toBe('normal')
	}, 30_000)
})
