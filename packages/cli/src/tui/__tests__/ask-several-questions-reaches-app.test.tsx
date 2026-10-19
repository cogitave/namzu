/**
 * A call with several questions reaches the screen as one card, and the
 * answers the operator gives reach the model one per question. The session
 * is mocked at `send()`, as in `ask-user-question-reaches-app`.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
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
			send: async function* (_messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
				const audience = {
					id: 'q1#0',
					question: 'Which audience is this for?',
					header: 'Audience',
					options: [
						{ id: 'opt_1', label: 'Board', description: 'High level', recommended: true },
						{ id: 'opt_2', label: 'Engineers', description: 'Details and diagrams' },
					],
					multiSelect: false,
					allowFreeText: true,
				}
				const answer = await opts?.onQuestion?.({
					questionId: 'q1',
					...audience,
					questions: [
						audience,
						{
							id: 'q1#1',
							question: 'Which environments?',
							header: 'Environment',
							options: [
								{ id: 'opt_1', label: 'Staging' },
								{ id: 'opt_2', label: 'Production' },
							],
							multiSelect: true,
							allowFreeText: false,
						},
					],
				})
				const text =
					answer?.kind === 'answer'
						? `MODEL GOT: ${(answer.answers ?? []).map((a) => `${a.questionId}=${a.selectedOptionIds.join('+')}`).join(' ')}`
						: `MODEL GOT: ${answer?.kind ?? 'nothing'}`
				yield { kind: 'delta', text } as AgentEvent
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = {
	cwd: process.cwd(),
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
	vi.clearAllMocks()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
const DOWN = '\u001b[B'

describe('a call with several questions', () => {
	it('is one card, and its answers reach the model one per question', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		const shows = (needle: string) =>
			vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain(needle))
		await shows('Type a message')
		await tick(60)
		harness.stdin.write('go')
		await tick(20)
		harness.stdin.write('\r')
		await shows('Which audience is this for?')
		const card = harness.lastFrame() ?? ''
		expect(card).toContain('Environment')
		expect(card).toContain('Submit')
		// Wait for the card to be committed before a key can pick a row.
		await tick(80)

		harness.stdin.write(DOWN)
		await tick(20)
		harness.stdin.write('\r')
		await shows('Which environments?')
		harness.stdin.write(' ')
		await shows('[x] Staging')
		harness.stdin.write(DOWN)
		await tick(20)
		harness.stdin.write(DOWN)
		await tick(20)
		harness.stdin.write('\r')
		await shows('Review your answers')
		harness.stdin.write('\r')

		await shows('MODEL GOT: q1#0=opt_2 q1#1=opt_1')
		expect(harness.lastFrame()).toContain('Answered "Which audience is this for?": Engineers')
	})
})
