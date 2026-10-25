/** A folded body names the key that opens it; the key appends nothing. */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

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

/**
 * Twelve lines, so six collapse and six hide. Distinguishable per line and
 * per block: an assertion that `line-9` reached the screen must not be
 * satisfiable by the OTHER block's ninth line, or the test would pass while
 * the wrong block was reprinted.
 */
const CALL_DETAIL = Array.from({ length: 12 }, (_, i) => `call-line-${i + 1}`)
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
			// The TUI never resumes a durable turn; a stub that answered would
			// make a resume look reachable from here.
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			// One tool call producing TWO collapsible bodies — the `⏺` call line
			// and the `⎿` result. Two is the minimum that can tell a working
			// lookup from one that always returns the last thing it saw.
			send: async function* (): AsyncIterable<AgentEvent> {
				yield {
					kind: 'tool-start',
					toolUseId: 'u1',
					toolName: 'bash',
					summary: 'ls',
					detail: CALL_DETAIL,
				} as AgentEvent
				await new Promise<void>((r) => setImmediate(r))
				yield {
					kind: 'tool-end',
					toolUseId: 'u1',
					toolName: 'bash',
					summary: 'ok',
					isError: false,
					detail: RESULT_DETAIL,
				} as AgentEvent
				yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
/** Yield to the event loop a few times so queued renders land; no wall-clock wait. */
const tick = async (_ms?: number): Promise<void> => {
	for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
}
const mounted: { unmount: () => void }[] = []

afterEach(() => {
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

/**
 * Poll rather than sleep a fixed interval.
 *
 * The same load cliff the permission-key harness documents: this suite
 * transforms TypeScript on the way in, and a fixed wait that passes this file
 * alone goes red inside the full parallel run — reported as "the output never
 * arrived" rather than as whatever the test was about.
 */
async function frameShows(
	lastFrame: () => string | undefined,
	text: string,
	timeoutMs?: number,
): Promise<void> {
	await vi.waitFor(() => expect(lastFrame() ?? '').toContain(text), timeoutMs)
}

/** Render, run the turn, and stop with two collapsed bodies on screen. */
async function twoCollapsedBlocks() {
	const harness = render(<App ctx={ctx} />)
	// Registered before the first assertion so a throw still tears down; a
	// leaked Ink instance turns one real failure into a column of fake ones.
	mounted.push(harness)
	// The COMPOSER's placeholder is not readiness — it draws from the first
	// frame, while the composer stays `disabled` until the session is up, so a
	// key sent on sight of it is dropped and the turn never runs. The connect
	// line is the first thing that only exists once `phase === 'ready'`.
	await frameShows(harness.lastFrame, 'a-model')
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	await frameShows(harness.lastFrame, 'result-line-12')
	expect(harness.lastFrame(), 'the turn never produced output').toContain('result-line-12')
	return harness
}

describe('a collapsed body advertises how to read it', () => {
	it('names the key, and nothing else', async () => {
		const { lastFrame } = await twoCollapsedBlocks()

		const frame = lastFrame() ?? ''
		// Both blocks hide six lines, and each points at the same key.
		expect(
			frame.split('… +6 lines (ctrl+o to expand)').length - 1,
			'both bodies name the key',
		).toBe(2)
		// The command this replaced must not still be advertised anywhere.
		expect(frame, 'a removed command is still advertised').not.toContain('/expand')
	})
})

describe('Ctrl+O', () => {
	it('opens the detailed transcript even when nothing is folded, and says nothing about expanding', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'a-model')

		harness.stdin.write('\x0f')
		await frameShows(harness.lastFrame, 'Showing detailed transcript')
		expect(harness.lastFrame() ?? '').not.toContain('Nothing to expand yet')
	})
})
