/** A tool-history repair is visible in the rendered conversation before output. */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

/** The events the next turn yields before its answer; each test sets its own. */
let turnEvents: AgentEvent[] = []

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv-history-repair',
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
			providerSummary: 'test-provider',
			modelSummary: 'test-model',
			toolNames: () => [],
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
				throw new Error('not used')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				for (const event of turnEvents) yield event
				yield { kind: 'delta', text: 'SAFEANSWER' }
				yield { kind: 'done' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const mounted: Array<{ unmount: () => void }> = []
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

const REPAIR: AgentEvent = {
	kind: 'history-repair',
	source: 'fresh-history',
	duplicateResults: 0,
	orphanedResults: 0,
	interruptedCalls: 1,
	text: 'Tool history repaired before the model call: 1 interrupted call closed with unknown outcome. Verify external state before retrying non-idempotent tools.',
}
const NO_TOOLS: AgentEvent = {
	kind: 'capability-warning',
	capability: 'tools',
	providerId: 'ollama',
	text: "Provider 'ollama' does not support tools — 42 registered tool(s) were stripped from the prompt and request.",
}

afterEach(() => {
	turnEvents = []
	for (const harness of mounted.splice(0)) harness.unmount()
	vi.clearAllMocks()
})

it('renders the repair warning before the assistant reply', async () => {
	turnEvents = [REPAIR]
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
	while (!(harness.lastFrame() ?? '').includes('test-model') && Date.now() < readyBy) {
		await tick()
	}
	expect(harness.lastFrame(), 'App never reached its connected composer').toContain('test-model')
	harness.stdin.write('continue')
	await tick()
	harness.stdin.write('\r')

	const doneBy = Date.now() + 4_000
	while (!harness.frames.join('\n').includes('SAFEANSWER') && Date.now() < doneBy) await tick()
	const rendered = harness.frames.join('\n')
	expect(rendered, 'turn never reached the rendered transcript').toContain('SAFEANSWER')
	const warningIndex = rendered.indexOf('Some steps in this conversation never finished')
	const answerIndex = rendered.indexOf('SAFEANSWER')
	expect(warningIndex).toBeGreaterThanOrEqual(0)
	expect(rendered.replace(/\s+/g, ' ')).toContain('Namzu marked them as unfinished')
	expect(rendered).not.toContain('interrupted call')
	expect(rendered).not.toContain('History warning')
	expect(rendered).not.toContain('non-idempotent')
	expect(answerIndex).toBeGreaterThan(warningIndex)
})

it('shows the kernel wording under the plain sentence only with --debug', async () => {
	turnEvents = [REPAIR]
	vi.stubEnv('NAMZU_DEBUG', '1')
	try {
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
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('test-model'))
		harness.stdin.write('continue')
		await tick()
		harness.stdin.write('\r')
		await vi.waitFor(() => expect(harness.frames.join('\n')).toContain('SAFEANSWER'))
		const rendered = harness.frames.join('\n').replace(/\s+/g, ' ')
		expect(rendered).toContain('Some steps in this conversation never finished')
		expect(rendered).toContain('Verify external state before retrying non-idempotent tools')
	} finally {
		vi.unstubAllEnvs()
	}
})

async function renderTurn(): Promise<string> {
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
	await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('test-model'))
	harness.stdin.write('continue')
	await tick()
	harness.stdin.write('\r')
	await vi.waitFor(() => expect(harness.frames.join('\n')).toContain('SAFEANSWER'))
	return harness.frames.join('\n').replace(/\s+/g, ' ')
}

it('says a provider without tools will only chat, and keeps the kernel wording for --debug', async () => {
	turnEvents = [NO_TOOLS]
	const plain = await renderTurn()
	expect(plain).toContain('Ollama can’t use tools, so Namzu will only chat while you use it.')
	expect(plain).not.toContain('does not support tools')
	expect(plain).not.toContain('42 registered')
	expect(plain).not.toContain('Capability warning')
	for (const harness of mounted.splice(0)) harness.unmount()

	vi.stubEnv('NAMZU_DEBUG', '1')
	try {
		const debug = await renderTurn()
		expect(debug).toContain('Ollama can’t use tools, so Namzu will only chat while you use it.')
		expect(debug).toContain('does not support tools')
		expect(debug).toContain('42 registered')
	} finally {
		vi.unstubAllEnvs()
	}
})
