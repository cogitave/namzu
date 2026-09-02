/**
 * Reasoning reaches the live region while it happens, and nowhere else.
 *
 * Two claims, and the second is the one that costs something if wrong: the
 * thinking row is shown while the model reasons, and once the reply starts
 * the row is gone and its text is in no message. Reasoning is ephemeral in
 * the kernel's own transcript; a TUI that promoted it to history would be
 * inventing a record the run does not keep.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

let releaseReply: () => void = () => {}

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
			send: async function* (): AsyncIterable<AgentEvent> {
				yield { kind: 'reasoning', text: 'first, weigh the ' } as AgentEvent
				yield { kind: 'reasoning', text: 'REASONING-SENTINEL options' } as AgentEvent
				await new Promise<void>((resolve) => {
					releaseReply = resolve
				})
				yield { kind: 'reasoning', text: '', done: true } as AgentEvent
				yield { kind: 'delta', text: 'The reply, after thinking.' } as AgentEvent
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

async function frameShows(read: () => string | undefined, needle: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if ((read() ?? '').includes(needle)) return
		await tick(20)
	}
	throw new Error(`no frame showed ${JSON.stringify(needle)} within ${budgetMs}ms`)
}

describe('the model thinking', () => {
	it('shows its current line under Working, then leaves no trace once the reply starts', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		harness.stdin.write('go')
		await tick(20)
		harness.stdin.write('\r')

		await frameShows(harness.lastFrame, 'thinking · first, weigh the REASONING-SENTINEL options')
		expect(harness.lastFrame() ?? '').toContain('Working')

		releaseReply()
		await frameShows(harness.lastFrame, 'The reply, after thinking.')
		await tick(80)
		const final = harness.lastFrame() ?? ''
		expect(final, 'reasoning is not a transcript row').not.toContain('REASONING-SENTINEL')
		expect(final).not.toContain('└ thinking')
	})
})
