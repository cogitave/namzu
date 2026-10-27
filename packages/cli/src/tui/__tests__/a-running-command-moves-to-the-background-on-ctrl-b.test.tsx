/**
 * A shell command that has run for a couple of seconds can be moved to the
 * background: the row says how, Ctrl+B does it, a message sent meanwhile does
 * it, and an interrupt says the command carries on. Without a command to move,
 * Ctrl+B keeps editing the draft.
 */

import type { BackgroundJob, ForegroundCommand } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }

let offered: readonly ForegroundCommand[]
let jobs: readonly BackgroundJob[]
let moves: string[]
let changeListeners: Set<() => void>
let turnStarted: Promise<void>
let announceTurnStarted: () => void
let releaseTurn: () => void
let sessionReady: Promise<void>
let announceSessionReady: () => void
let mounted: Screen | null = null
let handOverOnInterrupt = false

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

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => {
			announceSessionReady()
			return {
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
					throw new Error('not used by this test')
				},
				resumePaused: () => {
					throw new Error('not used by this test')
				},
				close: async () => {},
				promptExemptTools: () => [],
				jobs: () => jobs,
				foreground: {
					commands: () => offered,
					background: (reason) => {
						moves.push(reason)
						const moved = offered.length
						offered = []
						for (const listener of changeListeners) listener()
						return moved
					},
					onChange: (listener) => {
						changeListeners.add(listener)
						return () => changeListeners.delete(listener)
					},
				},
				send: async function* (_messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
					announceTurnStarted()
					// The kernel takes the running command over the moment the person's
					// interrupt fires, so the job exists by the time the abort returns.
					opts?.signal?.addEventListener(
						'abort',
						() => {
							if (handOverOnInterrupt) {
								jobs = [
									{
										id: 'b00000002',
										owner: 'session',
										command: 'npm test',
										status: 'running',
										startedAt: Date.now(),
									},
								]
							}
						},
						{ once: true },
					)
					yield {
						kind: 'tool-start',
						toolUseId: 'bash-1',
						toolName: 'bash',
						summary: 'npm test',
						command: 'npm test',
					}
					await new Promise<void>((resolve) => {
						releaseTurn = resolve
					})
					yield {
						kind: 'tool-end',
						toolUseId: 'bash-1',
						toolName: 'bash',
						summary: 'moved',
						isError: false,
					}
					yield { kind: 'done', stopReason: 'end_turn' }
				},
			}
		},
	}
})

const { App } = await import('../App.js')

beforeEach(() => {
	handOverOnInterrupt = false
	offered = []
	jobs = []
	moves = []
	changeListeners = new Set()
	sessionReady = new Promise<void>((resolve) => {
		announceSessionReady = resolve
	})
	turnStarted = new Promise<void>((resolve) => {
		announceTurnStarted = resolve
	})
	releaseTurn = () => {
		throw new Error('the turn is not running')
	}
})

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

async function mount(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 30, scrollback: 200 })
	mounted = screen
	await sessionReady
	await screen.waitForRender()
	return screen
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

function offer(): void {
	offered = [{ id: 'fg-1', owner: 'session', command: 'npm test', startedAt: Date.now() }]
	for (const listener of changeListeners) listener()
}

it('shows a hint only once the command is offered, and Ctrl+B moves it', async () => {
	vi.stubEnv('TMUX', '')
	const screen = await mount()
	await submit(screen, 'run the tests')
	await turnStarted
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('npm test')
	expect(screen.viewport().join('\n')).not.toContain('to run in background')

	offer()
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('(ctrl+b to run in background)')

	screen.press('\x02')
	await screen.waitForRender()
	expect(moves).toEqual(['user'])
	// Moved: nothing is offered any more, so the hint is gone.
	expect(screen.viewport().join('\n')).not.toContain('to run in background')
	releaseTurn()
	await screen.waitForRender()
})

it('says to press the key twice inside tmux', async () => {
	vi.stubEnv('TMUX', '/tmp/tmux-1000/default,1,0')
	const screen = await mount()
	await submit(screen, 'run the tests')
	await turnStarted
	offer()
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('(ctrl+b ctrl+b (twice) to run in background)')
	releaseTurn()
	await screen.waitForRender()
})

it('keeps Ctrl+B as cursor-left when there is nothing to move', async () => {
	const screen = await mount()
	screen.press('abc')
	await screen.waitForRender()
	screen.press('\x02')
	await screen.waitForRender()
	screen.press('X')
	await screen.waitForRender()
	expect(moves).toEqual([])
	// The X landed before the last letter: the cursor moved left.
	expect(screen.viewport().join('\n')).toMatch(/abX.?c/)
})

it('moves the command when a message is sent while it runs', async () => {
	const screen = await mount()
	await submit(screen, 'run the tests')
	await turnStarted
	offer()
	await screen.waitForRender()
	await submit(screen, 'also check the lint output')
	expect(moves).toEqual(['message'])
	releaseTurn()
	await screen.waitForRender()
})

it('leaves the command running and says so when the turn is interrupted', async () => {
	const screen = await mount()
	await submit(screen, 'run the tests')
	await turnStarted
	await screen.waitForRender()
	handOverOnInterrupt = true
	screen.press('\x1b')
	while (!screen.viewport().join('\n').includes('Interrupted')) {
		await screen.waitForRender()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	expect(screen.viewport().join('\n')).toContain(
		'Interrupted · The command continues in the background',
	)
})
