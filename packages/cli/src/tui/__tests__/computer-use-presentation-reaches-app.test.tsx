/** Desktop activity is narrated for the operator, not exposed as tool protocol. */

import { afterEach, expect, it, vi } from 'vitest'

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
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield {
					kind: 'tool-start',
					toolUseId: 'shot',
					toolName: 'computer_use',
					summary: 'Capture screenshot',
					standalone: true,
				}
					yield {
						kind: 'tool-end',
						toolUseId: 'shot',
						toolName: 'computer_use',
						summary: 'Screenshot captured (5120x1440, image/png).',
						isError: false,
					}
					yield {
						kind: 'capability-warning',
						capability: 'vision',
						contentSource: 'tool-result',
						text: 'The active provider will receive an explicit text fallback.',
					}
				yield {
					kind: 'tool-start',
					toolUseId: 'key-ok',
					toolName: 'computer_use',
					summary: 'Press WIN',
					standalone: true,
				}
				yield {
					kind: 'tool-end',
					toolUseId: 'key-ok',
					toolName: 'computer_use',
					summary: 'ok',
					hidden: true,
					isError: false,
				}
				yield {
					kind: 'tool-start',
					toolUseId: 'key-failed',
					toolName: 'computer_use',
					summary: 'Press CTRL+R',
					standalone: true,
				}
				yield {
					kind: 'tool-end',
					toolUseId: 'key-failed',
					toolName: 'computer_use',
					summary: 'desktop bridge failed',
					hidden: true,
					isError: true,
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

it('shows authored desktop actions, screenshot dimensions and failures without empty acknowledgements', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40, scrollback: 200 })
	mounted = screen
	const painted = () => screen.scrollback().join('\n')
	await waitUntil(screen, () => painted().includes('Connected to a-provider'))

	screen.press('inspect')
	await screen.waitForRender()
	screen.press('\r')
	await waitUntil(screen, () => painted().includes('failed: desktop bridge failed'))

	const transcript = painted()
	expect(transcript).toContain('✓ Capture screenshot')
	expect(transcript).toContain('Screenshot captured (5120x1440, image/png).')
	expect(transcript).toContain('Capability warning (vision tool result)')
	expect(transcript).toContain('The active provider will receive an explicit text fallback.')
	expect(transcript).toContain('✓ Press WIN')
	expect(transcript).toContain('✗ Press CTRL+R')
	expect(transcript).toContain('failed: desktop bridge failed')
	expect(transcript).not.toContain('Computer_use(')
	expect(transcript).not.toContain('⎿ ok')
})
