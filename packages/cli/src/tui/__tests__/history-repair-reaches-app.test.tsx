/** A tool-history repair is visible in the rendered conversation before output. */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

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
				yield {
					kind: 'history-repair',
					source: 'fresh-history',
					duplicateResults: 0,
					orphanedResults: 0,
					interruptedCalls: 1,
					text: 'Tool history repaired before the model call: 1 interrupted call closed with unknown outcome. Verify external state before retrying non-idempotent tools.',
				}
				yield { kind: 'delta', text: 'SAFEANSWER' }
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
	vi.clearAllMocks()
})

it('renders the repair warning before the assistant reply', async () => {
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
	const warningIndex = rendered.indexOf('Some earlier steps in this conversation were unfinished')
	const answerIndex = rendered.indexOf('SAFEANSWER')
	expect(warningIndex).toBeGreaterThanOrEqual(0)
	expect(rendered.replace(/\s+/g, ' ')).toContain('1 interrupted step marked as unfinished')
	expect(rendered).not.toContain('History warning')
	expect(rendered).not.toContain('non-idempotent')
	expect(answerIndex).toBeGreaterThan(warningIndex)
})

it('shows the kernel wording under the plain sentence only with --debug', async () => {
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
		expect(rendered).toContain('Some earlier steps in this conversation were unfinished')
		expect(rendered).toContain('Verify external state before retrying non-idempotent tools')
	} finally {
		vi.unstubAllEnvs()
	}
})
