/** `/debug-config` is useful only if launch provenance survives App and reaches a row. */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
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
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => [],
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			approvalLatched: () => false,
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
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
let mounted: { unmount: () => void } | undefined

afterEach(() => {
	mounted?.unmount()
	mounted = undefined
	vi.restoreAllMocks()
})

async function waitFor(
	harness: { readonly frames: readonly string[] },
	text: string,
): Promise<void> {
	const started = performance.now()
	while (!harness.frames.join('\n').includes(text) && performance.now() - started < 3_000) {
		await tick(20)
	}
	expect(harness.frames.join('\n')).toContain(text)
}

it('shows the exact winning source handed to App', async () => {
	const sourcePath = '/UNIQUE_CONFIG_SOURCE/namzu.config.json'
	const ctx: TuiContext = {
		cwd: '/w',
		version: '0.0.0-test',
		configDebug: {
			sources: { permissions: { kind: 'project-file', path: sourcePath } },
		},
	}
	const harness = render(<App ctx={ctx} />)
	mounted = harness
	await waitFor(harness, '> Type a message')

	harness.stdin.write('/debug-config')
	await tick()
	harness.stdin.write('\r')

	await waitFor(harness, `permissions: project-file "${sourcePath}"`)
})
