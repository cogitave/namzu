/**
 * One job exit, one announcement.
 *
 * The kernel may deliver an exit on a tool result or an awaited-job context
 * message. The CLI carries only exits the kernel did not acknowledge, including
 * one that lands after the last result but before the turn settles.
 */

import type { BackgroundJob } from '@namzu/sdk'
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
/** The last message of each send, as the model received it. */
const lastMessages: { text: string; source: unknown }[] = []
const contextAt = (index: number) => sends[index]?.hostContext?.().join('\n\n') ?? ''
let announce: ((job: BackgroundJob) => void) | undefined
let acknowledgeFirstExit = true
let acknowledgeBeforeListener = false
let failFirstSend = false

function exited(id: string, command: string): BackgroundJob {
	return {
		id,
		owner: 'session',
		command,
		status: 'exited',
		startedAt: 0,
		exitedAt: 1,
		exitCode: 0,
	}
}

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
			promptExemptTools: () => [],
			onJobExit: (listener) => {
				announce = listener
				return () => {
					announce = undefined
				}
			},
			send: async function* (messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
				sends.push(opts)
				const last = messages.at(-1)
				lastMessages.push({
					text: String(last?.content),
					source: (last as { source?: unknown } | undefined)?.source,
				})
				if (sends.length === 1) {
					if (acknowledgeBeforeListener) opts?.onJobNoticeDelivered?.(['b00000001'])
					announce?.(exited('b00000001', 'pnpm build'))
					if (acknowledgeFirstExit && !acknowledgeBeforeListener)
						opts?.onJobNoticeDelivered?.(['b00000001'])
					if (failFirstSend) throw new Error('provider failed before accepting context')
					yield {
						kind: 'job',
						jobId: 'b00000001',
						command: 'pnpm build',
						status: 'exited',
						exitCode: 0,
					}
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
	acknowledgeFirstExit = true
	acknowledgeBeforeListener = false
	failFirstSend = false
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

it('does not re-announce a job exit that landed while a turn was open', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))

	await say(screen, 'first', 1)
	await say(screen, 'second', 2)

	// The exit landed while the first turn was running, so the kernel had it.
	// The next turn must not open by announcing it a second time.
	expect(contextAt(1)).not.toContain('b00000001')
	expect(contextAt(1)).not.toContain('Background jobs that ended')
	expect(
		screen
			.scrollback()
			.filter((line) => line.includes('Background command "pnpm build" completed (exit code 0)')),
	).toHaveLength(1)

	// The control, and the reason the guard is not simply "never announce": an
	// exit with no turn open reaches nobody else, so the session wakes the model
	// with it, and the person types nothing.
	announce?.(exited('b00000002', 'pnpm test'))
	await waitUntil(screen, () => sends.length >= 3)
	expect(lastMessages[2]?.text).toContain('Background jobs that ended')
	expect(lastMessages[2]?.text).toContain('b00000002')
	expect(lastMessages[2]?.text).not.toContain('b00000001')
	expect(lastMessages[2]?.source).toEqual({ type: 'runtime-context', kind: 'job-exit' })
	// Said once: it is not in the context of the wake turn as well.
	expect(contextAt(2)).not.toContain('b00000002')
	await say(screen, 'third', 4)
	expect(contextAt(3)).not.toContain('b00000002')
})

it('does not wake the model for a command the operator stopped', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	await say(screen, 'first', 1)
	announce?.({ ...exited('b00000003', 'sleep 300'), status: 'killed' })
	await screen.waitForRender()
	await say(screen, 'second', 2)
	expect(sends).toHaveLength(2)
	// The next message still carries it, as it always did.
	expect(contextAt(1)).toContain('b00000003')
})

it('wakes the model with an exit that landed after the final tool result', async () => {
	acknowledgeFirstExit = false
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))

	await say(screen, 'first', 1)
	// The turn ended with the exit unacknowledged: the session starts the next one itself.
	await waitUntil(screen, () => sends.length >= 2)
	expect(lastMessages[1]?.text).toContain('b00000001')
	expect(lastMessages[1]?.source).toEqual({ type: 'runtime-context', kind: 'job-exit' })
	await say(screen, 'second', 3)
	expect(contextAt(2)).not.toContain('b00000001')
})

it('keeps an exit pending when the next send fails before accepting context', async () => {
	acknowledgeFirstExit = false
	failFirstSend = true
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))

	await say(screen, 'first', 1)
	await say(screen, 'retry', 2)
	expect(contextAt(1)).toContain('b00000001')
	await say(screen, 'later', 3)
	expect(contextAt(2)).not.toContain('b00000001')
})

it('does not requeue an exit acknowledged before the CLI exit listener runs', async () => {
	acknowledgeBeforeListener = true
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))

	await say(screen, 'first', 1)
	await say(screen, 'second', 2)
	expect(contextAt(1)).not.toContain('b00000001')
	expect(
		screen
			.scrollback()
			.filter((line) => line.includes('Background command "pnpm build" completed (exit code 0)')),
	).toHaveLength(1)
})

it('delivers operator shell output as request context, not as a system instruction', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	screen.press('!printf SHELL_OBSERVATION')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('SHELL_OBSERVATION'))
	await say(screen, 'what happened', 1)
	expect(contextAt(0)).toContain('SHELL_OBSERVATION')
	expect(sends[0]?.extraSystem ?? '').not.toContain('SHELL_OBSERVATION')
})
