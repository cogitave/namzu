/**
 * Golden transcript of event wakes through the rendered App.
 *
 * What ended while nobody was talking (a monitor event, a background command)
 * starts a turn of its own, exactly once, and an event the kernel already
 * delivered inside a turn is never offered again. These scenarios record what
 * the session was asked and must pass unchanged after the round machinery moves
 * out of the screen.
 */

import type { BackgroundJob } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { createMonitorInbox } from '../../integrations/monitors/inbox.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import { RoundLog } from '../__fixtures__/round-log.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const roundLog = new RoundLog()
const sends: (SendOptions | undefined)[] = []
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
				roundLog.record(messages, opts)
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
	roundLog.clear()
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

async function say(screen: Screen, text: string, turns: number): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => sends.length >= turns)
	await waitUntil(screen, () => screen.scrollback().join('\n').includes(text))
}

it('G4 wakes an idle session once for a monitor event and delivers it once', async () => {
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
	await say(screen, 'later', 3)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "first"",
		  "#1 runtime-context:job-exit rows=14 "<system-event-<nonce> kind=\\"job\\" id=\\"b00000009\\" status=\\"interim\\" at=\\"1970-01-01T00:00:00.001Z\\">"",
		  "#2 typed rows=1 "later"",
		]
	`)
})

it('G4 turns two events that land in one tick into one wake turn', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)
	inbox.addEvent(monitorEvent(1, 'ONE'))
	inbox.addEvent(monitorEvent(2, 'TWO'))
	await waitUntil(screen, () => sends.length >= 2)
	await say(screen, 'later', 3)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "first"",
		  "#1 runtime-context:job-exit rows=14 "<system-event-<nonce> kind=\\"job\\" id=\\"b00000009\\" status=\\"interim\\" at=\\"1970-01-01T00:00:00.002Z\\">"",
		  "#2 typed rows=1 "later"",
		]
	`)
})

it('G4 offers an event the kernel delivered inside a turn to nobody again', async () => {
	deliverInTurn = true
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)
	await say(screen, 'second', 2)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "first"",
		  "#1 typed rows=1 "second"",
		]
	`)
})

it('G4 wakes an idle session once when a background command exits', async () => {
	jobs = [
		{
			id: 'b00000010',
			owner: 'session',
			command: 'pnpm build',
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
	await say(screen, 'first', 1)
	announce?.({
		...jobs[0],
		status: 'exited',
		exitedAt: 4000,
		exitCode: 2,
	} as BackgroundJob)
	await waitUntil(screen, () => sends.length >= 2)
	await say(screen, 'later', 3)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "first"",
		  "#1 runtime-context:job-exit rows=2 "Background jobs that ended:"",
		  "#2 typed rows=1 "later"",
		]
	`)
})

it('G4 does not wake an idle session for a command the operator killed', async () => {
	jobs = [
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
	await say(screen, 'first', 1)
	announce?.({
		...jobs[0],
		status: 'killed',
		stopReason: 'stopped',
		exitedAt: 4000,
	} as BackgroundJob)
	await screen.waitForRender()
	await screen.waitForRender()
	await say(screen, 'second', 2)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "first"",
		  "#1 typed rows=1 "second" ctx="Background jobs that ended since your last turn:\\n- background job b00000010 (pnpm dev) was stopped"",
		]
	`)
})
