/**
 * One job exit, one announcement.
 *
 * Two layers can tell the model a background job ended, and they divide the
 * cases rather than sharing them. The kernel owns the exit that lands while a
 * run is open — it rides out on the next tool result, or, since the run now
 * holds itself open for a job the model awaited, as the message that releases
 * that hold. The session owns the exit that lands when no run is open: the
 * kernel is not there to hear it, so it is held and opens the next turn.
 *
 * The seam between them is `abortRef`, and it is load-bearing rather than
 * incidental. Drop it and every exit during a turn is announced twice — once
 * by the kernel, once as "jobs that ended since your last turn" — which is the
 * duplicate-delivery defect the task-completion inbox was built to avoid.
 */

import type { BackgroundJob } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const sends: (SendOptions | undefined)[] = []
let announce: ((job: BackgroundJob) => void) | undefined

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
			onJobExit: (listener) => {
				announce = listener
				return () => {
					announce = undefined
				}
			},
			send: async function* (_messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
				sends.push(opts)
				// Mid-run, which is the kernel's case: this is the moment the
				// hold would take the exit and put it in front of the model.
				if (sends.length === 1) announce?.(exited('job_1', 'pnpm build'))
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
	announce = undefined
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

it('does not re-announce a job exit that landed while a run was open', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model default'))

	await say(screen, 'first', 1)
	await say(screen, 'second', 2)

	// The exit landed while the first turn was running, so the kernel had it.
	// The next turn must not open by announcing it a second time.
	expect(sends[1]?.extraSystem ?? '').not.toContain('job_1')
	expect(sends[1]?.extraSystem ?? '').not.toContain('Background jobs that ended')

	// The control, and the reason the guard is not simply "never announce": an
	// exit with no run open reaches nobody else, so the session carries it.
	announce?.(exited('job_2', 'pnpm test'))
	await say(screen, 'third', 3)

	expect(sends[2]?.extraSystem ?? '').toContain('Background jobs that ended since your last turn')
	expect(sends[2]?.extraSystem ?? '').toContain('job_2')
	expect(sends[2]?.extraSystem ?? '').not.toContain('job_1')
})
