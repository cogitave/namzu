/**
 * What the interactive App hands `createAgentSession`, from what the CLI
 * handed the App.
 *
 * `web-fetch-reaches-the-turn` proves the session honours `web`; it drives
 * `createAgentSession` directly and so cannot see the hop before it — the
 * App reading `ctx.web` and passing it on — which is exactly the hop that
 * was missing when that test was written and green. The same hop carries
 * `askUser`, which only the App knows to be true.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Every options object the App passed to `createAgentSession`. */
const sessionOptions: Record<string, unknown>[] = []

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
		createAgentSession: async (
			_prefs: unknown,
			_detected: unknown,
			options: Record<string, unknown>,
		): Promise<AgentSession> => {
			sessionOptions.push(options)
			return {
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
					yield { kind: 'done' } as AgentEvent
				},
			}
		},
	}
})

const { App } = await import('../App.js')

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
	sessionOptions.length = 0
	vi.clearAllMocks()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function openWith(web: { fetch?: boolean } | undefined) {
	const ctx: TuiContext = {
		cwd: process.cwd(),
		version: '0.0.0-test',
		rules: [],
		skipPermissions: false,
		...(web ? { web } : {}),
	} as unknown as TuiContext
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	const deadline = Date.now() + 4000
	while (Date.now() < deadline && sessionOptions.length === 0) await tick(20)
	const options = sessionOptions[0]
	if (!options) throw new Error('the App never created a session')
	return options
}

describe('the App creating its session', () => {
	it('passes the web config it was given, and says somebody can answer questions', async () => {
		const options = await openWith({ fetch: true })
		expect(options.web).toEqual({ fetch: true })
		expect(options.askUser).toBe(true)
	})

	it('passes no web config when it was given none', async () => {
		const options = await openWith(undefined)
		expect(options.web).toBeUndefined()
	})
})
