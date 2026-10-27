/**
 * While a plan step is in progress the working row names it, in the words the
 * model gave for it ("Running the tests"), instead of the default word. The
 * row falls back to the step's subject when the model gave no such form.
 * Drives a rendered `<App>`, since only the frame shows what the person sees.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Held open by the mocked session so the turn stays in progress while frames are read. */
let release: () => void = () => {}
let withActiveForm = true

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

const pause = () => new Promise((r) => setTimeout(r, 60))

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
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				yield {
					kind: 'task',
					taskId: 't1',
					subject: 'Run the tests',
					status: 'in_progress',
					...(withActiveForm ? { activeForm: 'Running the tests' } : {}),
				}
				await new Promise<void>((resolve) => {
					release = resolve
				})
				yield { kind: 'delta', text: 'Finished.' }
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = {
	// The footer must not depend on a worktree name containing "owner".
	cwd: '/workspace/namzu',
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	release()
	for (const m of mounted.splice(0)) m.unmount()
	withActiveForm = true
	vi.clearAllMocks()
	vi.unstubAllEnvs()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function open() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Type a message'), {
		timeout: 30_000,
	})
	await tick(60)
	return harness
}

async function submit(harness: ReturnType<typeof render>, text: string) {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\r')
}

describe('the working row', () => {
	it('names the step in progress in the words the model gave', async () => {
		const harness = await open()
		await submit(harness, 'go')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Running the tests'), {
			timeout: 30_000,
		})
		expect(harness.lastFrame() ?? '', 'the default word gives way').not.toContain('Working')
	})

	it('names the step by its subject when the model gave no other form', async () => {
		withActiveForm = false
		const harness = await open()
		await submit(harness, 'go')
		// The subject is already in the checklist block (its header and its line);
		// a third copy, on a line of its own, is the working row.
		await vi.waitFor(
			() => expect((harness.lastFrame() ?? '').split('Run the tests').length - 1).toBe(3),
			{ timeout: 30_000 },
		)
		expect(harness.lastFrame() ?? '').not.toContain('Working')
	})
})
