/**
 * The notify decision point is an App boundary: with the point on, the end of a
 * finished reply is put to the decision model and a confident answer decides the chime;
 * in shadow mode the model is asked and nothing changes; off, it is never asked. These
 * drive the rendered App with a fake decision model.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

const played: Array<{ readonly verdict: string | undefined }> = []
const asked: string[] = []
let answer = 0.9

vi.mock('../../integrations/notifications/sound.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/notifications/sound.js')>()
	return {
		...actual,
		playMoment: (_moment: unknown, _turnMs: unknown, options: { verdict?: string }) => {
			played.push({ verdict: options.verdict })
			return undefined
		},
	}
})
vi.mock('../../integrations/decision/model.js', () => ({
	maybeCreateDecisionModel: () => ({
		yesno: async (state: string) => {
			asked.push(state)
			return { p: answer }
		},
	}),
	buildDecisionProviderConfig: () => ({}),
	maybeCreateDecisionTool: () => undefined,
}))
// The decision log must not write under the real home.
vi.mock('../../integrations/decision/points.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/decision/points.js')>()
	return {
		...actual,
		createDecisionPoints: (options: Parameters<typeof actual.createDecisionPoints>[0]) =>
			actual.createDecisionPoints({ ...options, log: () => {} }),
	}
})
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
	asked.length = 0
	vi.clearAllMocks()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

// No deadline of its own: a frame that never shows the text is a hang, and the
// per-test timeout reports that.
async function frameShows(read: () => string | undefined, needle: string) {
	while (!(read() ?? '').includes(needle)) await tick(20)
}

async function runOneTurn(decision?: TuiContext['decision']) {
	const ctx = {
		cwd: '/workspace/namzu',
		version: '0.0.0-test',
		rules: [],
		skipPermissions: false,
		...(decision ? { decision } : {}),
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

const http = (points?: Record<string, string>) =>
	({
		provider: 'http',
		url: 'http://localhost:9',
		...(points ? { points } : {}),
	}) as TuiContext['decision']

describe('the notify decision point', () => {
	it('on: a confident yes sounds a reply the length rule would have left silent', async () => {
		answer = 0.9
		await runOneTurn(http({ notify: 'on' }))
		expect(asked).toHaveLength(1)
		expect(asked[0]).toContain('All done.')
		expect(played[0]?.verdict).toBe('yes')
	})

	it('on: an unsure answer leaves the rule alone', async () => {
		answer = 0.5
		await runOneTurn(http({ notify: 'on' }))
		expect(played[0]?.verdict).toBe('unsure')
	})

	it('shadow: the model is asked and the sound is decided by the rule alone', async () => {
		answer = 0.9
		await runOneTurn(http({ notify: 'shadow' }))
		expect(asked).toHaveLength(1)
		expect(played[0]?.verdict).toBe('unsure')
	})

	it('off, or with no decision block: the model is never asked', async () => {
		await runOneTurn(http())
		expect(asked).toEqual([])
		expect(played[0]?.verdict).toBeUndefined()
		played.length = 0
		await runOneTurn(undefined)
		expect(asked).toEqual([])
	})
})
