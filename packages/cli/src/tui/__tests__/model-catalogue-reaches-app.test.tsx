/** Real tool presenters and event adapter reach the rendered transcript. */

import { afterEach, expect, it, vi } from 'vitest'
import { ToolRegistry, ReadFileTool, GrepTool, JobTool, createToolPresenter, generateTurnId, type SessionEvent } from '@namzu/sdk'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
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
			toolNames: () => ['computer_use'],
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
			send: async function* (): AsyncIterable<AgentEvent> {
				const registry = new ToolRegistry()
				registry.register([ReadFileTool, GrepTool, JobTool])
				const presenter = createToolPresenter(registry)
				const turnId = generateTurnId()
                const calls = [{ toolName: 'agent_models', input: { query: 'muse' }, result: JSON.stringify({ models: [{ provider: 'zen', id: 'muse-spark-1.3-contributor-free', name: 'Muse Spark 1.3 Contributor Free', contextWindow: 1048576, effortLevels: ['low', 'medium', 'high'], supportsAnonymousAccess: true }], omitted: 0 }), isError: false }]

				for (const [index, call] of calls.entries()) {
					for (const event of [
						{ type: 'tool_executing', turnId, toolUseId: `call-${index}`, toolName: call.toolName, input: call.input },
						{ type: 'tool_completed', turnId, toolUseId: `call-${index}`, toolName: call.toolName, result: call.result, isError: call.isError ?? false },
					]) {
						const mapped = actual.toAgentEvent(event as unknown as SessionEvent, presenter)
						if (mapped) yield mapped
					}
				}
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
	vi.restoreAllMocks()
})

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 120): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate()).toBe(true)
}

it.each([40, 80])('renders a compact catalogue and expands the exact receipt at %i columns', async cols => {
 const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows: 40, scrollback: 200 })
 mounted = screen
 const painted = () => screen.scrollback().join('\n')
 // The hint is matched on the row with its wrapping collapsed. A catalogue
 // fact line is prose in a bordered pane, so the renderer soft-wraps it —
 // and where it breaks is a fact about the fixture's width, not about the
 // hint. Reading the hint as one phrase is the assertion; reading it as one
 // LINE was an accident of this fixture's length, and the price fact added
 // one word too many for it to hold at either width here.
 const flattened = () => painted().replace(/\s+/g, ' ')
 await waitUntil(screen, () => painted().includes('a-model'))
 screen.press('find muse')
 await screen.waitForRender()
 screen.press('\r')
 await waitUntil(screen, () => flattened().includes('ctrl+o details'))
 expect(painted()).toContain('Available models')
 expect(painted()).toContain('Muse Spark 1.3 Contributor Free')
 expect(painted()).toContain('Context 1M')
 expect(painted()).not.toContain('supportsAnonymousAccess')
 expect(painted()).not.toContain('Explored')
 screen.press('\x0f')
 await waitUntil(screen, () => painted().includes('supportsAnonymousAccess'))
})
