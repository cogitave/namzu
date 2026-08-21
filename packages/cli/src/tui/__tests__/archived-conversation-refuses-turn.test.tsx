/** An already-closed conversation is refused at App's real turn boundary. */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const observed = vi.hoisted(() => ({ admissions: 0, sends: 0, appends: 0 }))

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'ses_closed',
	requireWritableConversation: async () => {
		observed.admissions += 1
		throw new Error('Project prj_closed is archived; start conversation turn rejected')
	},
	appendMessages: async () => {
		observed.appends += 1
	},
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
			providerSummary: 'test-provider',
			modelSummary: 'test-model',
			toolNames: () => [],
			errorHint: null,
			errorKind: null,
			agentIds: [],
			configNotices: [],
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			resumeDurable: async () => {
				throw new Error('not used')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				observed.sends += 1
				yield { kind: 'delta', text: 'MUST_NOT_RUN' }
				yield { kind: 'done' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const mounted: Array<{ unmount: () => void }> = []
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
	for (const harness of mounted.splice(0)) harness.unmount()
	observed.admissions = 0
	observed.sends = 0
	observed.appends = 0
})

it('refuses before provider work or persistence instead of reviving the conversation', async () => {
	const harness = render(
		<App
			ctx={
				{
					cwd: process.cwd(),
					version: '0.0.0-test',
					rules: [],
					skipPermissions: false,
				} as TuiContext
			}
		/>,
	)
	mounted.push(harness)
	const readyBy = Date.now() + 4_000
	while (!(harness.lastFrame() ?? '').includes('Connected to test-provider') && Date.now() < readyBy) {
		await tick()
	}
	expect(harness.lastFrame()).toContain('Connected to test-provider')

	harness.stdin.write('do not run')
	await tick()
	harness.stdin.write('\r')
	const refusedBy = Date.now() + 4_000
	while (!(harness.lastFrame() ?? '').includes('This turn was not started') && Date.now() < refusedBy) {
		await tick()
	}

	expect(harness.lastFrame()).toContain('Project prj_closed is archived')
	expect(harness.frames.join('\n')).not.toContain('MUST_NOT_RUN')
	expect(observed).toEqual({ admissions: 1, sends: 0, appends: 0 })
})
