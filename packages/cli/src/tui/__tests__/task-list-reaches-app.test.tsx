/**
 * The model's plan reaches the screen as a checklist in the transcript, once.
 *
 * Task calls used to reach the operator as their protocol: `☐subject` rows,
 * `Task created: <uuid> — "…" [owner: namzu]`, `1 tasks: 0 completed…`, and
 * a live list above the composer repeating the same tasks a second time.
 * Now consecutive task operations fold into one transcript block — a header
 * in words and the checklist as it stood afterwards — and the row above the
 * composer names the current step only while that block is out of view.
 * These drive a rendered `<App>` and read the frames, which is the only
 * thing that can establish what an operator sees.
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
			promptExemptTools: () => [],
			send: async function* (): AsyncIterable<AgentEvent> {
				turn += 1
				if (turn === 1) {
					yield { kind: 'task', taskId: 't1', subject: 'Çalışma alanını incele', status: 'pending' }
					yield { kind: 'task', taskId: 't2', subject: 'Cover it with tests', status: 'pending' }
					await pause()
					yield { kind: 'delta', text: 'Starting on the first one.\n\n' }
					await pause()
					yield { kind: 'task', taskId: 't1', subject: 'Çalışma alanını incele', status: 'in_progress' }
					await pause()
					yield { kind: 'delta', text: 'Looked around.\n\n' }
					await pause()
					yield { kind: 'task', taskId: 't1', subject: 'Çalışma alanını incele', status: 'completed' }
					yield { kind: 'task', taskId: 't2', subject: 'Cover it with tests', status: 'in_progress' }
					await pause()
					yield { kind: 'delta', text: 'Writing the tests now.\n\n' }
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

const count = (frame: string, needle: string) => frame.split(needle).length - 1

describe('the task checklist', () => {
	it('folds consecutive additions into one block, with one space after each mark', async () => {
		const harness = await open()
		await submit(harness, 'go')

		await frameShows(harness.lastFrame, 'Added 2 tasks')
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('□ Çalışma alanını incele')
		expect(frame).toContain('□ Cover it with tests')
		expect(frame, 'no mark runs into its text').not.toMatch(/[□■✓✗][^ \n]/)
		expect(frame, 'no emoji-presentation marks').not.toMatch(/[☐☑☒◐⏸]/)
	})

	it('names each later operation in words and redraws the checklist under it', async () => {
		const harness = await open()
		await submit(harness, 'go')

		await frameShows(harness.lastFrame, 'Started · Çalışma alanını incele')
		expect(harness.lastFrame() ?? '').toContain('■ Çalışma alanını incele')

		// A completion and the next start in one step are one block.
		await frameShows(harness.lastFrame, 'Tasks · 1/2 done')
		let frame = harness.lastFrame() ?? ''
		expect(frame).toContain('✓ Çalışma alanını incele')
		expect(frame).toContain('■ Cover it with tests')

		await frameShows(harness.lastFrame, 'Completed · Cover it with tests')
		frame = harness.lastFrame() ?? ''
		expect(frame).toContain('✓ Cover it with tests')
	})

	it('never shows an id, an owner or a tool receipt', async () => {
		const harness = await open()
		await submit(harness, 'go')
		await frameShows(harness.lastFrame, 'All done, first turn.')
		const everything = harness.frames.join('\n')
		expect(everything).not.toContain('t1')
		expect(everything).not.toContain('owner')
		expect(everything).not.toContain('Task created')
		expect(everything).not.toMatch(/\d+ tasks:/)
	})

	it('shows the plan once: the current-step row appears only when the checklist is not the newest row', async () => {
		const harness = await open()
		await submit(harness, 'go')

		// Right after the additions, the block is the newest row: one copy.
		await frameShows(harness.lastFrame, 'Added 2 tasks')
		expect(count(harness.lastFrame() ?? '', 'Cover it with tests')).toBe(1)

		// Text after a block pushes it up; the row names the step it is on.
		await frameShows(harness.lastFrame, 'Looked around.')
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('■ Çalışma alanını incele · 0/2 done')
		expect(frame, 'not a second checklist').not.toContain('Tasks · 0/2 done')
	})

	it('leaves the finished plan in the transcript and clears the row when the plan is done', async () => {
		const harness = await open()
		await submit(harness, 'go')
		await frameShows(harness.lastFrame, 'All done, first turn.')
		await tick(80)
		const frame = harness.lastFrame() ?? ''
		expect(frame).not.toContain('· 2/2 done')
		expect(frame).toContain('Completed · Cover it with tests')

		await submit(harness, 'again')
		await frameShows(harness.lastFrame, 'Second turn reply.')
		expect(count(harness.lastFrame() ?? '', 'Completed · Cover it with tests')).toBe(1)
	})
})
