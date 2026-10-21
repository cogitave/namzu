/**
 * A monitor's events and an idle terminal.
 *
 * An event that arrives while nobody is talking wakes the model with it; one
 * the kernel already put in front of the model during a turn is never offered
 * again; and the monitor counts apart from shells in the footer.
 */

import type { BackgroundJob } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { createMonitorInbox } from '../../integrations/monitors/inbox.js'
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
const lastMessages: { text: string; source: unknown }[] = []
const contextAt = (index: number) => sends[index]?.hostContext?.().join('\n\n') ?? ''
const inbox = createMonitorInbox()
let announce: ((job: BackgroundJob) => void) | undefined
let deliverInTurn = false
let startMonitorInTurn = false
let watching = 0
let jobs: BackgroundJob[] = []

function monitorEvent(seq: number, text: string) {
	return {
		id: `b00000009:${seq}`,
		jobId: 'b00000009',
		owner: 'session',
		description: 'errors in deploy log',
		kind: 'output' as const,
		text,
		at: seq,
		command: 'tail -f deploy.log',
	}
}

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))

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
			jobs: () => jobs,
			onJobExit: (listener) => {
				announce = listener
				return () => {
					announce = undefined
				}
			},
			monitors: {
				addEvent: (e) => inbox.addEvent(e),
				addEnd: (j, s) => inbox.addEnd(j, s),
				acknowledge: (ids) => inbox.acknowledge(ids),
				peek: () => inbox.peek(),
				take: () => inbox.take(),
				wakes: () => inbox.wakes(),
				get size() {
					return inbox.size
				},
				onChange: (l) => inbox.onChange(l),
				running: () => watching,
				stats: () => ({ stdoutChars: 0 }),
			},
			send: async function* (messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
				sends.push(opts)
				const last = messages.at(-1)
				lastMessages.push({
					text: String(last?.content),
					source: (last as { source?: unknown } | undefined)?.source,
				})
				if (deliverInTurn && sends.length === 1) {
					// The kernel put this event on a tool result and said so; the
					// session's own wrapper also clears its ledger (see runTurn).
					const event = monitorEvent(1, 'DEPLOY_IN_TURN')
					inbox.addEvent(event)
					opts?.onMonitorEventsDelivered?.([event.id])
					inbox.acknowledge([event.id])
				}
				if (startMonitorInTurn && sends.length === 1) {
					// The job exists before the tool's end event, as the kernel's does.
					jobs = [
						{
							id: 'b00000009',
							owner: 'session',
							command: 'tail -f deploy.log',
							status: 'running',
							startedAt: 0,
							kind: 'monitor',
							description: 'errors in deploy log',
						},
					]
					watching = 1
					yield {
						kind: 'tool-start',
						toolUseId: 'm1',
						toolName: 'monitor',
						summary: 'errors in deploy log',
					} as AgentEvent
					yield {
						kind: 'tool-end',
						toolUseId: 'm1',
						toolName: 'monitor',
						summary: 'started',
						isError: false,
					} as AgentEvent
				}
				yield { kind: 'delta', text: 'ok' }
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	sends.length = 0
	lastMessages.length = 0
	announce = undefined
	deliverInTurn = false
	startMonitorInTurn = false
	watching = 0
	jobs = []
	inbox.take()
	vi.restoreAllMocks()
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 160): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate()).toBe(true)
}

/** Turns the session started itself for a monitor, rather than for something typed. */
const wakeTurns = () =>
	lastMessages.filter(
		(message) => (message.source as { kind?: string } | undefined)?.kind === 'job-exit',
	).length

async function say(screen: Screen, text: string, turns: number): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => sends.length >= turns)
	await waitUntil(screen, () => screen.scrollback().join('\n').includes(text))
}

it('wakes an idle session with a monitor event, in the untrusted envelope, and says it once', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)

	inbox.addEvent(monitorEvent(1, 'DEPLOY_FAILED'))
	await waitUntil(screen, () => sends.length >= 2)
	expect(lastMessages[1]?.text).toContain('Monitor event: "errors in deploy log"')
	expect(lastMessages[1]?.text).toContain('DEPLOY_FAILED')
	expect(lastMessages[1]?.source).toEqual({
		type: 'runtime-context',
		kind: 'job-exit',
	})
	// No transcript row per event, and no raw job id in what the person reads.
	expect(screen.scrollback().join('\n')).not.toContain('DEPLOY_FAILED')
	expect(screen.scrollback().join('\n')).not.toContain('b00000009')

	await say(screen, 'later', 3)
	expect(lastMessages[2]?.text).toBe('later')
	expect(contextAt(2)).not.toContain('DEPLOY_FAILED')
})

it('does not deliver again an event the kernel put in front of the model during a turn', async () => {
	deliverInTurn = true
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)
	// Give a wrongly queued wake turn every chance to start before asserting.
	await say(screen, 'second', 2)
	expect(sends).toHaveLength(2)
	// Counted directly: no turn of the model's own accord started for the event.
	expect(wakeTurns()).toBe(0)
	expect(contextAt(1)).not.toContain('DEPLOY_IN_TURN')
})

it('counts monitors apart from shells in the footer and says how a monitor ended', async () => {
	watching = 1
	jobs = [
		{
			id: 'b00000009',
			owner: 'session',
			command: 'tail -f deploy.log',
			status: 'running',
			startedAt: 0,
			kind: 'monitor',
			description: 'errors in deploy log',
		},
		{
			id: 'b00000010',
			owner: 'session',
			command: 'pnpm dev',
			status: 'running',
			startedAt: 0,
		},
	]
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await waitUntil(screen, () => screen.viewport().join('\n').includes('1 monitor'))
	expect(screen.viewport().join('\n')).toContain('1 shell · 1 monitor')

	announce?.({
		...jobs[0],
		status: 'exited',
		exitedAt: 4000,
		exitCode: 0,
	} as BackgroundJob)
	await waitUntil(screen, () =>
		screen.scrollback().join('\n').includes('Monitor "errors in deploy log" ended without'),
	)
})

it('shows a monitor in the footer the moment its start returns, before anything else refreshes', async () => {
	startMonitorInTurn = true
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	expect(screen.viewport().join('\n')).not.toContain('1 monitor')
	await say(screen, 'watch the deploy log', 1)
	await waitUntil(screen, () => screen.viewport().join('\n').includes('1 monitor'))
})

it('does not wake an idle session for a stop the operator asked for, and tells it with the next turn', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)

	inbox.addEnd(
		{
			id: 'b00000009',
			owner: 'session',
			command: 'tail -f deploy.log',
			status: 'killed',
			stopReason: 'stopped',
			startedAt: 0,
			exitedAt: 1,
			kind: 'monitor',
			description: 'errors in deploy log',
		},
		{ stdoutChars: 0 },
	)
	// Give a wrongly queued wake turn every chance to start before asserting.
	await screen.waitForRender()
	expect(sends).toHaveLength(1)
	expect(wakeTurns()).toBe(0)

	await say(screen, 'second', 2)
	expect(lastMessages[1]?.text).toBe('second')
	expect(contextAt(1)).toContain('errors in deploy log')
	expect(contextAt(1)).toContain('stopped')
	expect(wakeTurns()).toBe(0)
})
