/** `/mcp` reads transport state when Enter is pressed, not when the line was typed. */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const live = vi.hoisted(() => ({ dropped: false }))
const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'provider',
			modelSummary: 'model',
			toolNames: () => ['mcp_tickets_create'],
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			// Deliberately stale startup projections. `/mcp` must use mcpStatus,
			// otherwise this fixture recreates the exact lie the operator saw.
			mcpConnected: [{ name: 'tickets', toolCount: 1, tools: ['mcp_tickets_create'] }],
			mcpFailed: [],
			mcpStatus: () =>
				live.dropped
					? {
							connected: [],
							failed: [{ name: 'tickets', reason: 'connection closed after startup' }],
						}
					: {
							connected: [
								{
									name: 'tickets',
									toolCount: 1,
									tools: ['mcp_tickets_create'],
								},
							],
							failed: [],
						},
			agentIds: [],
			configNotices: [],
			approvalLatched: () => false,
			resetApprovalLatch: () => {},
			promptExemptTools: () => [],
			resumeDurable: async () => {
				throw new Error('not used')
			},
			close: async () => {},
			send: async function* () {
				yield { kind: 'done', stopReason: 'end_turn' } as const
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
let mounted: ReturnType<typeof render> | undefined

beforeEach(() => {
	live.dropped = false
})

afterEach(() => {
	mounted?.unmount()
	mounted = undefined
})

async function waitFor(text: string): Promise<void> {
	const started = performance.now()
	while (!mounted?.frames.join('\n').includes(text) && performance.now() - started < 3_000) {
		await tick()
	}
	expect(mounted?.frames.join('\n')).toContain(text)
}

it('reports a drop that happens after the command text rendered but before submission', async () => {
	mounted = render(<App ctx={ctx} />)
	await waitFor('> Type a message')

	mounted.stdin.write('/mcp')
	await waitFor('/mcp')

	// No React state change accompanies a transport callback. The command must
	// therefore ask the session now; a roster captured by the preceding render
	// still says connected in this exact window.
	live.dropped = true
	mounted.stdin.write('\r')

	await waitFor('tickets — NOT available: connection closed after startup')
	expect(mounted.frames.join('\n')).not.toContain('tickets — connected, 1 tool(s)')
})
