/**
 * Ctrl+T shows or hides the model's checklist above the message box.
 *
 * Folded, the live region names the one current step. Open, it lists every task
 * (up to five rows, the rest counted) and the footer reads `ctrl+t to hide
 * tasks`; folded, it reads `ctrl+t to show tasks`. A task the model creates or
 * changes opens the list, but while the transcript's own copy of the list is in
 * view the panel waits, so the list is never drawn twice at once. No slash
 * command shows the checklist.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { type TaskListItem, expandedTaskRows, taskListRows } from '../TaskList.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

/** Six tasks in one turn, so the open list has to count what it leaves out. */
vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

const SUBJECTS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six']

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
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
				for (const [index, subject] of SUBJECTS.entries()) {
					yield { kind: 'task', taskId: `t${index}`, subject: `Step ${subject}`, status: 'pending' }
				}
				yield { kind: 'delta', text: 'Planned.' }
				yield { kind: 'done' } as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = {
	cwd: '/workspace/namzu',
	version: '0.0.0-test',
	rules: [],
	skipPermissions: false,
} as unknown as TuiContext

const mounted: Array<{ unmount: () => void }> = []
afterEach(() => {
	for (const m of mounted.splice(0)) m.unmount()
	vi.unstubAllEnvs()
})

async function open() {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Type a message'))
	await new Promise((resolve) => setTimeout(resolve, 60))
	return harness
}

const CTRL_T = '\x14'

describe('Ctrl+T and the checklist', () => {
	it('opens the list at most five rows tall, counts the rest, and folds it again', async () => {
		// The saved choice is written to the user file; keep it out of the real one.
		vi.stubEnv('NAMZU_HOME', mkdtempSync(join(tmpdir(), 'namzu-todos-')))
		vi.stubEnv('COLUMNS', '100')
		vi.stubEnv('LINES', '12')
		const harness = await open()
		harness.stdin.write('plan it')
		await new Promise((resolve) => setTimeout(resolve, 20))
		harness.stdin.write('\r')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Planned.'))

		// Opened by the model's own tasks, but the short screen has pushed the
		// transcript copy out of view, so the panel is what shows the plan.
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('ctrl+t to hide tasks'))
		let frame = harness.lastFrame() ?? ''
		expect(frame).toContain('… +2 more')

		harness.stdin.write(CTRL_T)
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('ctrl+t to show tasks'))
		frame = harness.lastFrame() ?? ''
		expect(frame).not.toContain('… +2 more')

		harness.stdin.write(CTRL_T)
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('ctrl+t to hide tasks'))
		expect(harness.lastFrame() ?? '').toContain('… +2 more')
	})

	it('has no slash command that shows the checklist', async () => {
		const harness = await open()
		harness.stdin.write('/tasks')
		await new Promise((resolve) => setTimeout(resolve, 20))
		harness.stdin.write('\r')
		await vi.waitFor(() => expect(harness.lastFrame() ?? '').toContain('Background'))
		expect(harness.lastFrame() ?? '').not.toContain('Tasks ·')
	})
})

describe('expandedTaskRows', () => {
	const task = (id: string, status: TaskListItem['status']): TaskListItem => ({
		id,
		subject: id,
		status,
	})

	it('shows a list of five or fewer whole', () => {
		const tasks = [task('a', 'completed'), task('b', 'in_progress'), task('c', 'pending')]
		expect(expandedTaskRows(tasks)).toEqual({ shown: tasks, hidden: 0 })
		expect(taskListRows(tasks, true)).toBe(3)
	})

	it('keeps the step in progress, then the pending ones, then the latest finished, in list order', () => {
		const tasks = [
			task('a', 'completed'),
			task('b', 'completed'),
			task('c', 'completed'),
			task('d', 'in_progress'),
			task('e', 'pending'),
			task('f', 'pending'),
		]
		const { shown, hidden } = expandedTaskRows(tasks)
		expect(shown.map((t) => t.id)).toEqual(['c', 'd', 'e', 'f'])
		expect(hidden).toBe(2)
		expect(taskListRows(tasks, true)).toBe(5)
		expect(taskListRows(tasks, false)).toBe(1)
	})
})
