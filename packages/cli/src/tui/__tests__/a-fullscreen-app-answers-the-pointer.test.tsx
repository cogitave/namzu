/**
 * The fullscreen screen end to end, with the pointer: a rendered `<App>` given the registry the
 * launcher feeds. A link in a reply opens on ctrl-click and explains itself on a plain click, the
 * answer shows in the footer and not in the conversation; a click on the footer's mode item cycles
 * the mode; a click on a permission answer decides the question. The browser is never started: the
 * opener is a stand-in that says no.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, PermissionDecision } from '../agent.js'
import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import type { PointerReport } from '../fullscreen/mouse-wheel.js'
import { createPointerRegions } from '../pointer/regions.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const URL = 'https://example.com/docs/report'
const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }
const decisions: PermissionDecision[] = []
let askForPermission = false
let nowMs = 1_000_000

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
// No browser is started from a test.
vi.mock('../open-browser.js', () => ({ openInBrowser: () => false }))

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
			allowForSession: () => undefined,
			commandArguments: new Map([['bash', 'command']]),
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				yield { kind: 'delta', text: `The docs are at ${URL} today.` } as AgentEvent
				if (askForPermission) {
					const decision = await opts?.onPermission?.({
						toolCalls: [
							{ id: 'c1', name: 'bash', input: { command: 'npm test' }, isDestructive: false },
						],
						sessionId: 's',
					} as never)
					if (decision) decisions.push(decision)
				}
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: process.cwd(), version: '0.0.0-test' }
const COLS = 100
const ROWS = 24
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	decisions.length = 0
	askForPermission = false
	vi.restoreAllMocks()
})

const text = (screen: Screen) => screen.viewport().join('\n')
async function until(screen: Screen, needle: string): Promise<void> {
	while (!text(screen).includes(needle)) await screen.waitForRender()
}

async function mount() {
	const regions = createPointerRegions()
	const pointerListeners = new Set<(report: PointerReport) => void>()
	const screen = await renderToScreen(
		<App
			ctx={ctx}
			fullscreen={{
				subscribeWheel: () => () => undefined,
				regions,
				subscribePointer: (listener) => {
					pointerListeners.add(listener)
					return () => void pointerListeners.delete(listener)
				},
			}}
		/>,
		{ cols: COLS, rows: ROWS, alternateScreen: true, incrementalRendering: true },
	)
	mounted = screen
	await until(screen, 'Type a message')
	// What the launcher does with a report: the regions first, then the window.
	const send = async (report: PointerReport) => {
		if (!regions.handle(report)) for (const listener of pointerListeners) listener(report)
		await screen.waitForRender()
	}
	const click = async (x: number, y: number, mods: Partial<PointerReport> = {}) => {
		await send({ kind: 'press', x, y, ...mods })
		await send({ kind: 'release', x, y, ...mods })
	}
	const at = (needle: string) => {
		const y = screen.viewport().findIndex((row) => row.includes(needle)) + 1
		return { y, x: (screen.viewport()[y - 1]?.indexOf(needle) ?? -1) + 1 }
	}
	const submit = async (prompt: string) => {
		screen.press(prompt)
		await screen.waitForRender()
		screen.press('\r')
	}
	return { screen, send, click, at, submit }
}

it('opens a link on ctrl-click, explains it on a plain click, and answers in the footer', async () => {
	const m = await mount()
	await m.submit('go')
	await until(m.screen, URL)
	await until(m.screen, 'Type a message')
	const link = m.at('https://')
	const rowsBefore = m.screen.viewport().slice(0, ROWS - 4)

	await m.click(link.x + 3, link.y)
	await until(m.screen, 'Ctrl+click opens this link in your browser.')
	const footer = m.screen.viewport().findIndex((row) => row.includes('Ctrl+click opens'))
	// The frame is one row short of the terminal: the footer is its last row.
	expect(footer, 'the note is in the footer row, under the composer').toBe(ROWS - 2)
	// the conversation above did not move or take the note
	expect(m.screen.viewport().slice(0, ROWS - 4)).toEqual(rowsBefore)

	await m.click(link.x + 3, link.y, { ctrl: true })
	await until(m.screen, `Couldn't open your browser. Open ${URL} yourself.`)
})

it('cycles the permission mode when the mode item of the footer is clicked', async () => {
	const m = await mount()
	const mode = m.at('shift+tab to cycle')
	expect(mode.y).toBe(ROWS - 1)
	await m.click(mode.x + 2, mode.y)
	await until(m.screen, 'accept edits on')
})

it('decides a permission question on a click on its answer, after the settle window', async () => {
	askForPermission = true
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
	const m = await mount()
	await m.submit('go')
	await until(m.screen, 'enter confirm')
	const yes = m.at('1. Yes')
	// inside the window an approval does not count, as with the key
	await m.click(yes.x + 3, yes.y)
	expect(decisions).toEqual([])
	nowMs += APPROVAL_SETTLE_MS + 1
	await m.click(yes.x + 3, yes.y)
	await vi.waitFor(() => expect(decisions).toEqual([{ kind: 'approve' }]))
})

it('opens the detailed transcript on ctrl+o as the scrolling window, with its keys named', async () => {
	const m = await mount()
	await m.submit('go')
	await until(m.screen, URL)
	m.screen.press('\x0f')
	await until(m.screen, 'Detailed transcript')
	expect(m.screen.viewport()[0]).toContain('/ search')
	// the reply is there with the model that wrote it, and the composer has stood aside
	expect(text(m.screen)).toContain('a-model')
	expect(text(m.screen)).not.toContain('Type a message')
	m.screen.press('q')
	await until(m.screen, 'Type a message')
})
