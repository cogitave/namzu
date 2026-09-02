/**
 * A question from the model reaches the screen as a chooser, and the row the
 * operator picks reaches the model.
 *
 * The session here is mocked at `send()`: it asks through `onQuestion`, then
 * streams whatever came back as the reply, so the frame shows both what was
 * asked and what the tool would have received. Three exits are covered —
 * a row, free text, and Esc — because each is a separate resolution path in
 * `App`, and a path that never resolves is a turn that never ends.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

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
			agentIds: [],
			configNotices: [],
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (_messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
				const answer = await opts?.onQuestion?.({
					questionId: 'q1',
					question: 'Which audience is this for?',
					header: 'Audience',
					options: [
						{ id: 'opt_1', label: 'Board (Recommended)', description: 'High level' },
						{ id: 'opt_2', label: 'Engineers', description: 'Details and diagrams' },
					],
					multiSelect: false,
					allowFreeText: true,
				})
				const text =
					answer?.kind === 'answer'
						? `MODEL GOT: ${answer.selectedOptionIds.join(',') || 'free'}${answer.freeText ? ` "${answer.freeText}"` : ''}`
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
const ESC = '\u001b'

async function frameShows(read: () => string | undefined, needle: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if ((read() ?? '').includes(needle)) return
		await tick(20)
	}
	throw new Error(`no frame showed ${JSON.stringify(needle)} within ${budgetMs}ms`)
}

async function askedOnScreen() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	await frameShows(harness.lastFrame, 'Which audience is this for?')
	// Wait for the chooser to be committed before a key can pick a row.
	await tick(80)
	const frame = harness.lastFrame() ?? ''
	expect(frame).toContain('Board (Recommended)')
	expect(frame).toContain('Engineers')
	expect(frame, 'free text was allowed, so the escape hatch is offered').toContain('Something else…')
	return harness
}

describe('a question from the model', () => {
	it('is answered by the row the operator picks', async () => {
		const harness = await askedOnScreen()
		harness.stdin.write(DOWN)
		await tick(40)
		harness.stdin.write('\r')

		await frameShows(harness.lastFrame, 'MODEL GOT: opt_2')
		expect(harness.lastFrame() ?? '', 'the choice is recorded where it happened').toContain(
			'Answered "Which audience is this for?": Engineers',
		)
	})

	it('is answered in the operator’s own words through the escape hatch', async () => {
		const harness = await askedOnScreen()
		harness.stdin.write(DOWN)
		await tick(30)
		harness.stdin.write(DOWN)
		await tick(30)
		harness.stdin.write('\r')
		await frameShows(harness.lastFrame, 'Type your answer')
		await tick(40)
		harness.stdin.write('the sales team')
		await tick(30)
		harness.stdin.write('\r')

		await frameShows(harness.lastFrame, 'MODEL GOT: free "the sales team"')
	})

	it('is skipped by Esc, and the model is told so rather than handed a choice', async () => {
		const harness = await askedOnScreen()
		harness.stdin.write(ESC)

		await frameShows(harness.lastFrame, 'MODEL GOT: skip')
		expect(harness.lastFrame() ?? '').not.toContain('Answered "')
	})
})
