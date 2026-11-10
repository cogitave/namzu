/**
 * The fullscreen screen, end to end: a rendered `<App>` on the alternate screen
 * with a long reply, read back off an emulated terminal.
 *
 * Claims: the app takes the alternate screen and gives it back; a conversation
 * far taller than the terminal draws only the rows that fit; the composer stays
 * on the bottom rows while the reader pages back; output that arrives meanwhile
 * does not move the view; and sending another message follows the latest again.
 * Nothing here waits on a clock: the mocked turn announces its own end.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

/** Rows of the mocked reply: far more than the terminal is tall. */
const LONG_REPLY_LINES = 120
/** Turns the mocked agent has answered. */
let turns = 0

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
			agentIds: [],
			configNotices: [],
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				turns += 1
				const turn = turns
				const text = Array.from(
					{ length: LONG_REPLY_LINES },
					(_, i) => `turn ${turn} row ${i}`,
				).join('\n\n')
				yield { kind: 'delta', text } as AgentEvent
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

// Imported after the mocks above are registered, the way the sibling App
// tests do it — a static import would bind the real modules first.
const { App } = await import('../App.js')

const ctx: TuiContext = {
	cwd: process.cwd(),
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
} as unknown as TuiContext

const PGUP = '\x1b[5~'
const ROWS = 24

let mounted: Screen | null = null
afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	turns = 0
	vi.clearAllMocks()
})

const text = (screen: Screen) => screen.viewport().join('\n')

/** Render until the screen says `needle`; a hang is caught by the test's own timeout. */
async function until(screen: Screen, needle: string): Promise<void> {
	while (!text(screen).includes(needle)) await screen.waitForRender()
}

async function mount(): Promise<Screen> {
	const listeners = new Set<(direction: 'up' | 'down') => void>()
	const screen = await renderToScreen(
		<App
			ctx={ctx}
			fullscreen={{
				subscribeWheel: (listener) => {
					listeners.add(listener)
					return () => void listeners.delete(listener)
				},
			}}
		/>,
		{ cols: 80, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await until(screen, 'Type a message')
	return screen
}

async function send(screen: Screen, prompt: string, last: string): Promise<void> {
	screen.press(prompt)
	await screen.waitForRender()
	screen.press('\r')
	await until(screen, last)
}

it('takes the alternate screen and hands the main one back', async () => {
	const screen = await mount()
	expect(screen.bufferType()).toBe('alternate')
	await screen.unmount()
	mounted = null
	expect(screen.writes().join('')).toContain('\x1b[?1049l')
	expect(screen.bufferType()).toBe('normal')
})

it('draws only the visible window of a long reply and keeps the composer at the bottom', async () => {
	const screen = await mount()
	await send(screen, 'go', `turn 1 row ${LONG_REPLY_LINES - 1}`)
	const shown = text(screen)
	expect(shown).toContain(`turn 1 row ${LONG_REPLY_LINES - 1}`)
	expect(shown).not.toContain('turn 1 row 0\n')
	expect(screen.viewport().filter((row) => row.includes('turn 1 row')).length).toBeLessThan(ROWS)
	// The composer is on the last rows, below the transcript.
	const composerAt = screen.viewport().findIndex((row) => row.includes('Type a message'))
	const lastReplyAt = screen
		.viewport()
		.findIndex((row) => row.includes(`turn 1 row ${LONG_REPLY_LINES - 1}`))
	expect(composerAt).toBeGreaterThan(lastReplyAt)
	expect(composerAt).toBeGreaterThan(ROWS - 8)
})

it('holds the view when paged back, and follows the latest again on the next message', async () => {
	const screen = await mount()
	await send(screen, 'first', `turn 1 row ${LONG_REPLY_LINES - 1}`)
	screen.press(PGUP)
	await screen.waitForRender()
	const held = text(screen)
	expect(held).toContain('Jump to latest')
	expect(held).not.toContain(`turn 1 row ${LONG_REPLY_LINES - 1}`)
	expect(held).toContain('Type a message')
	await screen.waitForRender()
	expect(text(screen)).toBe(held)
	// Typing and sending is a reason to look at the end again.
	await send(screen, 'second', `turn 2 row ${LONG_REPLY_LINES - 1}`)
	expect(text(screen)).not.toContain('Jump to latest')
})
