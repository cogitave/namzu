/**
 * The model's plan reaches the screen as ONE checklist.
 *
 * While the turn runs it lives under the working line and updates in place;
 * the transcript gets no block per update. When the turn ends, its final state
 * is printed once, if it changed during the turn. These drive a rendered
 * `<App>` and read the frames, which is the only thing that can establish what
 * an operator sees.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Emitted by the mocked session on the first turn; the second turn is text only. */
let turn = 0
/** When set, the first turn adds two tasks and removes one instead. */
let removal = false
/**
 * When set, the first turn waits after its second reply instead of going on to complete the
 * first task. The state a test reads there (`0/2 done`) is otherwise a window of a pause long:
 * a loaded runner that is slow to handle a key misses it and the step has moved on.
 */
let holdAfterSecondReply = false
let releaseHeld: () => void = () => {}
let held: Promise<void> = Promise.resolve()

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
				turn += 1
				if (removal) {
					yield { kind: 'task', taskId: 't1', subject: 'Çalışma alanını incele', status: 'pending' }
					yield { kind: 'task', taskId: 't2', subject: 'Eski adımı sil', status: 'pending' }
					await pause()
					yield { kind: 'delta', text: 'That second step is not needed.\n\n' }
					await pause()
					yield {
						kind: 'task',
						taskId: 't2',
						subject: 'Eski adımı sil',
						status: 'pending',
						removed: true,
					}
					await pause()
					yield { kind: 'delta', text: 'Removal done.' }
				} else if (turn === 1) {
					yield { kind: 'task', taskId: 't1', subject: 'Çalışma alanını incele', status: 'pending' }
					yield { kind: 'task', taskId: 't2', subject: 'Cover it with tests', status: 'pending' }
					await pause()
					yield { kind: 'delta', text: 'Starting on the first one.\n\n' }
					await pause()
					yield {
						kind: 'task',
						taskId: 't1',
						subject: 'Çalışma alanını incele',
						status: 'in_progress',
					}
					await pause()
					yield { kind: 'delta', text: 'Looked around.\n\n' }
					if (holdAfterSecondReply) await held
					else await pause()
					yield {
						kind: 'task',
						taskId: 't1',
						subject: 'Çalışma alanını incele',
						status: 'completed',
					}
					yield {
						kind: 'task',
						taskId: 't2',
						subject: 'Cover it with tests',
						status: 'in_progress',
					}
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
	// The footer must not depend on a worktree name containing "owner".
	cwd: '/workspace/namzu',
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
	releaseHeld()
	turn = 0
	removal = false
	holdAfterSecondReply = false
	vi.clearAllMocks()
	vi.unstubAllEnvs()
})

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Waits for the frame to show `needle` with no deadline of its own: a frame that
// never shows it is a hang, and the per-test timeout reports that. A wall-clock
// budget here measured how loaded the runner was, not whether the screen was right.
async function frameShows(read: () => string | undefined, needle: string) {
	while (!(read() ?? '').includes(needle)) await tick(20)
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
	it('draws the plan under the working line with one space after each mark', async () => {
		const harness = await open()
		await submit(harness, 'go')

		await frameShows(harness.lastFrame, '□ Cover it with tests')
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('□ Çalışma alanını incele')
		expect(frame, 'no mark runs into its text').not.toMatch(/[□■✓✗][^ \n]/)
		expect(frame, 'no emoji-presentation marks').not.toMatch(/[☐☑☒◐⏸]/)
		const rows = frame.split('\n')
		const working = rows.findIndex((row) => /Working|Writing|Thinking/u.test(row))
		const list = rows.findIndex((row) => row.includes('□ Çalışma alanını incele'))
		expect(working, 'the working line is on screen').toBeGreaterThanOrEqual(0)
		expect(list, 'the list is right under it').toBeGreaterThan(working)
		expect(list - working).toBeLessThanOrEqual(2)
	})

	it('updates the list in place and writes no block per update', async () => {
		const harness = await open()
		await submit(harness, 'go')

		await frameShows(harness.lastFrame, '■ Çalışma alanını incele')
		await frameShows(harness.lastFrame, '✓ Çalışma alanını incele')
		await frameShows(harness.lastFrame, '■ Cover it with tests')
		// Each step is on screen once: in the live list, never again as a row.
		const frame = harness.lastFrame() ?? ''
		expect(count(frame, 'Çalışma alanını incele')).toBe(1)
		expect(count(frame, 'Cover it with tests')).toBe(1)
		await frameShows(harness.lastFrame, 'All done, first turn.')
		const everything = harness.frames.join('\n')
		for (const block of ['Added 2 tasks', 'Started ·', 'Completed ·', 'Renamed']) {
			expect(everything, `no "${block}" row`).not.toContain(block)
		}
	})

	it('prints the list once, as it ended, when the turn is over', async () => {
		const harness = await open()
		await submit(harness, 'go')
		await frameShows(harness.lastFrame, 'All done, first turn.')
		await frameShows(harness.lastFrame, 'Tasks · 2/2 done')
		await tick(80)
		const frame = harness.lastFrame() ?? ''
		expect(count(frame, 'Tasks · 2/2 done')).toBe(1)
		expect(count(frame, '✓ Cover it with tests')).toBe(1)
		expect(frame).toContain('✓ Çalışma alanını incele')
		expect(frame, 'the live list is gone with the turn').not.toContain('■')

		// A turn that does not touch the plan prints nothing new.
		await submit(harness, 'again')
		await frameShows(harness.lastFrame, 'Second turn reply.')
		expect(count(harness.lastFrame() ?? '', 'Tasks · 2/2 done')).toBe(1)
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

	it('folds the list to the step it is on with Ctrl+T, and does not draw a second checklist', async () => {
		vi.stubEnv('COLUMNS', '100')
		vi.stubEnv('LINES', '40')
		// Ctrl+T saves its choice; keep that out of the real user file.
		vi.stubEnv('NAMZU_HOME', mkdtempSync(join(tmpdir(), 'namzu-todos-')))
		holdAfterSecondReply = true
		held = new Promise<void>((resolve) => {
			releaseHeld = resolve
		})
		const harness = await open()
		await submit(harness, 'go')

		// The turn waits here until the test has read the folded row, so no timing
		// decides whether `0/2 done` is still true.
		await frameShows(harness.lastFrame, 'Looked around.')
		await frameShows(harness.lastFrame, '□ Cover it with tests')
		harness.stdin.write('\x14')
		await frameShows(harness.lastFrame, '■ Çalışma alanını incele · 0/2 done')
		expect(harness.lastFrame() ?? '', 'folded to one step').not.toContain('□ Cover it with tests')
		releaseHeld()
	})

	it('drops a removed task from the list and from the printed final state', async () => {
		vi.stubEnv('COLUMNS', '100')
		vi.stubEnv('LINES', '60')
		removal = true
		const harness = await open()
		await submit(harness, 'go')
		await frameShows(harness.lastFrame, '□ Eski adımı sil')
		await frameShows(harness.lastFrame, 'Removal done.')
		await frameShows(harness.lastFrame, 'Tasks · 0/1 done')
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('□ Çalışma alanını incele')
		expect(frame).not.toContain('□ Eski adımı sil')
	})
})
