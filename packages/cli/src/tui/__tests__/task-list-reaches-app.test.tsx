/**
 * The model's plan reaches the screen as a live list, and leaves with the
 * request it belonged to.
 *
 * Before this, `task_create` / `task_update` were two transcript rows and
 * nothing between: a five-step plan was five rows scattered through tool
 * output, with no way to see which step was current. These drive a rendered
 * `<App>` through a turn that opens two tasks, works one, finishes both, and
 * then through a second turn — and read the frames, which is the only thing
 * that can establish what an operator sees.
 */

import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Emitted by the mocked session on the first turn; the second turn is text only. */
let turn = 0

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
				turn += 1
				if (turn === 1) {
					yield { kind: 'task', taskId: 't1', subject: 'Write the parser', status: 'pending' }
					yield { kind: 'task', taskId: 't2', subject: 'Cover it with tests', status: 'pending' }
					await pause()
					yield { kind: 'task', taskId: 't1', subject: 'Write the parser', status: 'in_progress' }
					await pause()
					yield { kind: 'task', taskId: 't1', subject: 'Write the parser', status: 'completed' }
					yield { kind: 'task', taskId: 't2', subject: 'Cover it with tests', status: 'in_progress' }
					await pause()
					yield { kind: 'task', taskId: 't2', subject: 'Cover it with tests', status: 'completed' }
					yield { kind: 'delta', text: 'All done, first turn.' }
				} else {
					yield { kind: 'delta', text: 'Second turn reply.' }
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
	for (const m of mounted.splice(0)) m.unmount()
	turn = 0
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

async function open() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await frameShows(harness.lastFrame, 'Type a message')
	await tick(60)
	return harness
}

async function submit(harness: ReturnType<typeof render>, text: string) {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\r')
}

describe('the live task list', () => {
	it('shows every task with its current mark, and counts what is done', async () => {
		const harness = await open()
		await submit(harness, 'go')

		await frameShows(harness.lastFrame, 'Tasks · 0/2 done')
		let frame = harness.lastFrame() ?? ''
		expect(frame).toContain('☐ Write the parser')
		expect(frame).toContain('☐ Cover it with tests')

		await frameShows(harness.lastFrame, '◐ Write the parser')

		await frameShows(harness.lastFrame, 'Tasks · 1/2 done')
		frame = harness.lastFrame() ?? ''
		expect(frame).toContain('☑ Write the parser')
		expect(frame).toContain('◐ Cover it with tests')

		await frameShows(harness.lastFrame, 'Tasks · 2/2 done')
	})

	it('keeps the finished list up after the turn, and clears it when the next request begins', async () => {
		const harness = await open()
		await submit(harness, 'go')
		await frameShows(harness.lastFrame, 'All done, first turn.')
		await tick(80)
		expect(harness.lastFrame() ?? '', 'the finished plan should stay until the operator moves on').toContain(
			'Tasks · 2/2 done',
		)

		await submit(harness, 'again')
		await frameShows(harness.lastFrame, 'Second turn reply.')
		expect(harness.lastFrame() ?? '').not.toContain('Tasks ·')
	})

	it('records the opening and the close in the transcript, not the churn', async () => {
		const harness = await open()
		await submit(harness, 'go')
		await frameShows(harness.lastFrame, 'All done, first turn.')
		// Read after the next request has cleared the list, so the frame holds
		// the transcript alone and the live rows cannot be counted twice.
		await submit(harness, 'again')
		await frameShows(harness.lastFrame, 'Second turn reply.')

		const frame = harness.lastFrame() ?? ''
		// One opening row and one closing row per task; the in-progress flip
		// changed the list and wrote nothing — the transcript is the record,
		// and a record of every flip is noise.
		expect(frame.split('☐ Write the parser').length - 1).toBe(1)
		expect(frame.split('☑ Write the parser').length - 1).toBe(1)
		expect(frame).not.toContain('◐ Write the parser')
	})
})
