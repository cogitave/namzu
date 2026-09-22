/**
 * Shift+Tab reaches the permission mode, and the mode reaches the screen.
 *
 * `/permissions accept-edits` already worked through the chooser; the key is
 * the reflex path, and a key that is bound in `Composer` but never wired from
 * `App` is a key that does nothing while the hint says otherwise. So this
 * drives a rendered `<App>`: the mode line is absent under `prompt`, appears
 * after Shift+Tab, names the key, and leaves after a second press.
 *
 * The footer is the key's only reply. Every press used to append
 * "Permissions: <mode> for this session. …" to the transcript, so five presses
 * left five lines; the reference terminal rewrites its footer and writes
 * nothing. And the key works while a turn runs: it used to be refused there
 * with "Permissions were not changed. Finish or stop the current work first."
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

/** Holds the turn open until the test releases it. */
let releaseTurn: (() => void) | null = null
let holdTurn = false
/** What the running turn would read at its next decision. */
let readMode: (() => string) | undefined
const recorded: string[] = []

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
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			approvalLatched: () => false,
			resetApprovalLatch: () => {},
			setPermissionMode: async (mode: string) => {
				recorded.push(mode)
			},
			promptExemptTools: () => [],
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				readMode = opts?.currentPermissionMode as (() => string) | undefined
				if (holdTurn) {
										await new Promise<void>((resolve) => {
						releaseTurn = resolve
					})
				}
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
	releaseTurn?.()
	releaseTurn = null
	holdTurn = false
	readMode = undefined
	recorded.length = 0
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
			'⏵⏵ Auto-approve edits',
		)

		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ Auto-approve edits')
		expect(harness.lastFrame() ?? '').toContain('shift+tab to cycle')

		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '‖ Plan (read-only)')

		harness.stdin.write(SHIFT_TAB)
		await frameStopsShowing(harness.lastFrame, '‖ Plan (read-only)')
		expect(harness.lastFrame() ?? '').not.toContain('⏵⏵ Auto-approve edits')
	})

	it('writes nothing to the transcript, however many times it is pressed', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		const before = harness.frames.length
		for (let i = 0; i < 5; i++) {
			harness.stdin.write(SHIFT_TAB)
			await tick(40)
		}
		await frameShows(harness.lastFrame, '‖ Plan (read-only)')
		const seen = harness.frames.slice(before).join('\n')
		expect(seen).not.toContain('Permissions:')
		expect(seen).not.toContain('for this session')
		expect(seen).not.toContain('⏸')
		// Five presses from `prompt`, each one recorded and none of them printed.
		expect(recorded).toEqual(['accept-edits', 'plan', 'prompt', 'accept-edits', 'plan'])
	})

	it('changes the mode while a turn runs, and the running turn reads the new one', async () => {
		holdTurn = true
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)
		harness.stdin.write('go')
		await tick(20)
		harness.stdin.write('\r')
		for (let waited = 0; releaseTurn === null && waited < 4000; waited += 20) await tick(20)
		expect(releaseTurn, 'the turn is running').not.toBeNull()
		expect(readMode?.(), 'the turn starts under the mode it was sent with').toBe('prompt')

		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ Auto-approve edits')
		expect(readMode?.(), 'the next decision of this same turn sees the change').toBe('accept-edits')
		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '‖ Plan (read-only)')
		expect(readMode?.()).toBe('plan')
		expect(recorded, 'each change is recorded for the running turn').toEqual(['accept-edits', 'plan'])
		expect(harness.lastFrame() ?? '').not.toContain('Permissions were not changed')
		expect(harness.lastFrame() ?? '').not.toContain('Permissions:')

		releaseTurn?.()
		await tick(200)
		expect(harness.lastFrame() ?? '', 'the mode outlives the turn it was changed in').toContain(
			'‖ Plan (read-only)',
		)
	})

	it('does not queue or submit the draft the way plain Tab would', async () => {
		const harness = render(<App ctx={ctx} />)
		mounted.push(harness)
		await frameShows(harness.lastFrame, 'Type a message')
		await tick(60)

		harness.stdin.write('half a thought')
		await tick(20)
		harness.stdin.write(SHIFT_TAB)
		await frameShows(harness.lastFrame, '⏵⏵ Auto-approve edits')

		expect(harness.lastFrame() ?? '', 'the draft is still in the composer').toContain(
			'half a thought',
		)
		expect(harness.lastFrame() ?? '').not.toContain('queued')
	})
})
