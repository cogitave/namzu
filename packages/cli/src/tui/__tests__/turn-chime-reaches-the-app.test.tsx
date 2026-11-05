/**
 * The chime is an App boundary: the moment a turn settles must reach the sound
 * module with how long the turn ran and whether the person turned sound off.
 * The module's own rules (which turns earn a sound, the spacing, the player)
 * are tested beside it; this establishes that the App asks, once, with the
 * right facts, and that it asks whether or not terminal notifications are set.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

const played: Array<{
	readonly moment: { readonly kind: string; readonly outcome?: string }
	readonly turnMs: number | undefined
	readonly enabled: boolean | undefined
}> = []

vi.mock('../../integrations/notifications/sound.js', () => ({
	playMoment: (
		moment: { kind: string; outcome?: string },
		turnMs: number | undefined,
		options: { enabled?: boolean },
	) => {
		played.push({ moment, turnMs, enabled: options.enabled })
		return undefined
	},
}))
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
				throw new Error('not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'delta', text: 'All done.' }
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
	played.length = 0
	vi.clearAllMocks()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

// No deadline of its own: a frame that never shows the text is a hang, and the
// per-test timeout reports that.
async function frameShows(read: () => string | undefined, needle: string) {
	while (!(read() ?? '').includes(needle)) await tick(20)
}

async function runOneTurn(tui?: TuiContext['tui']) {
	const ctx = {
		cwd: '/workspace/namzu',
		version: '0.0.0-test',
		rules: [],
		skipPermissions: false,
		...(tui ? { tui } : {}),
	} as unknown as TuiContext
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	await frameShows(harness.lastFrame, 'All done.')
	while (played.length === 0) await tick(20)
}

describe('the turn chime', () => {
	it('is asked for once when a turn settles, with how long it ran, with no terminal notification set', async () => {
		await runOneTurn()
		expect(played).toHaveLength(1)
		expect(played[0]?.moment).toEqual({ kind: 'turn-settled', outcome: 'completed' })
		expect(played[0]?.turnMs).toBeTypeOf('number')
		expect(played[0]?.turnMs).toBeGreaterThanOrEqual(0)
		expect(played[0]?.enabled).toBe(true)
	})

	it('is told when the person turned sound off', async () => {
		await runOneTurn({ sound: false })
		expect(played[0]?.enabled).toBe(false)
	})
})
