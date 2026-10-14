/**
 * Paging up from the composer opens the scrollable transcript inside the app,
 * on the normal screen, and leaves the session as it was when it closes.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const sends: (SendOptions | undefined)[] = []
/** Held open by the test so a reply can be mid-stream while the view is open. */
let release: (() => void) | undefined

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
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (_messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
				sends.push(opts)
				const body = Array.from({ length: 60 }, (_, i) => `reply row ${i}`).join('\n')
				yield { kind: 'delta', text: body }
				if (sends.length === 2) {
					await new Promise<void>((resolve) => {
						release = resolve
					})
					yield { kind: 'delta', text: '\nfresh output' }
				}
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	release?.()
	release = undefined
	await mounted?.unmount()
	mounted = null
	sends.length = 0
	vi.restoreAllMocks()
})

const PAGE_UP = '\x1b[5~'
const END = '\x1b[F'

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 160): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate()).toBe(true)
}

const shown = (screen: Screen) => screen.viewport().join('\n')

async function say(screen: Screen, text: string, turns: number): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => sends.length >= turns)
}

it('opens on Page Up, hints the way back, and End returns to the composer', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 80, rows: 30, scrollback: 400 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('reply row 59'))
	const scrollbackBefore = screen.scrollback().join('\n')

	// At the composer with the end in view: no hint.
	expect(shown(screen)).not.toContain('Back to bottom')

	screen.press(PAGE_UP)
	await waitUntil(screen, () => shown(screen).includes('↓ Back to bottom · esc'))
	expect(screen.bufferType()).toBe('normal')
	expect(shown(screen)).not.toContain('New activity')
	// The composer is still on screen under the hint.
	expect(shown(screen)).toContain('a-model')

	screen.press(END)
	await waitUntil(screen, () => !shown(screen).includes('Back to bottom'))
	expect(screen.bufferType()).toBe('normal')
	expect(screen.scrollback().join('\n')).toContain(scrollbackBefore.trimEnd().slice(-200))

	// The composer takes input again, as before.
	screen.press('hello')
	await waitUntil(screen, () => shown(screen).includes('hello'))
})

it('says New activity when a reply streams on while the view is scrolled up', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 80, rows: 30, scrollback: 400 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('reply row 59'))
	await say(screen, 'second', 2)
	await waitUntil(screen, () => release !== undefined)

	screen.press(PAGE_UP)
	await waitUntil(screen, () => shown(screen).includes('↓ Back to bottom · esc'))
	expect(shown(screen)).not.toContain('New activity')

	release?.()
	await waitUntil(screen, () => shown(screen).includes('New activity · ↓ Back to bottom · esc'))
	expect(screen.bufferType()).toBe('normal')
})
