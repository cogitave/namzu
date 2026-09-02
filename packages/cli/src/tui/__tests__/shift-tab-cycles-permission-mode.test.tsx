/**
 * Shift+Tab reaches the permission mode, and the mode reaches the screen.
 *
 * `/permissions accept-edits` already worked through the chooser; the key is
 * the reflex path, and a key that is bound in `Composer` but never wired from
 * `App` is a key that does nothing while the hint says otherwise. So this
 * drives a rendered `<App>`: the mode line is absent under `prompt`, appears
 * after Shift+Tab, names the key, and leaves after a second press.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

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
			resetApprovalLatch: () => {},
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
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
/** The escape sequence a terminal sends for Shift+Tab. */
const SHIFT_TAB = '\u001b[Z'

async function frameShows(read: () => string | undefined, needle: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if ((read() ?? '').includes(needle)) return
		await tick(20)
	}
	throw new Error(`no frame showed ${JSON.stringify(needle)} within ${budgetMs}ms`)
}

async function frameStopsShowing(read: () => string | undefined, needle: string, budgetMs = 4000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (!(read() ?? '').includes(needle)) return
		await tick(20)
	}
	throw new Error(`${JSON.stringify(needle)} still on screen after ${budgetMs}ms`)
}

describe('Shift+Tab in the composer', () => {
	it('turns accept-edits on, says so beside the input, and turns it off again', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		expect(harness.lastFrame() ?? '', 'the default mode draws no line').not.toContain(
			'accept edits on',
		)

		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ accept edits on')
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('shift+tab to cycle')
		expect(frame, 'the change is also a transcript fact').toContain(
			'Permission mode changed to accept-edits',
		)

		harness.stdin.write(SHIFT_TAB)
		await frameStopsShowing(harness.lastFrame, '⏵⏵ accept edits on')
		expect(harness.lastFrame() ?? '').toContain('Permission mode changed to prompt')
	})

	it('does not queue or submit the draft the way plain Tab would', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)

		harness.stdin.write('half a thought')
		await tick(20)
		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ accept edits on')

		expect(harness.lastFrame() ?? '', 'the draft is still in the composer').toContain(
			'half a thought',
		)
		expect(harness.lastFrame() ?? '').not.toContain('queued')
	})
})
