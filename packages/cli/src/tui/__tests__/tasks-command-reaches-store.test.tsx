import {
	InMemoryTaskStore,
	type TaskStore,
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { fakeAgentSession } from '../__fixtures__/agent-session.js'

const state = vi.hoisted(() => ({
	store: undefined as TaskStore | undefined,
	sends: 0,
	resets: 0,
	reads: 0,
}))
const tenantId = generateTenantId()
const projectId = generateProjectId()
const topicId = generateTopicId()

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({
		tenantId,
		projectId,
		topicId,
		root: '/tmp/namzu-tasks-command-test',
	}),
	startConversation: async () => generateSessionId(),
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: { version: 3, providers: [{ id: 'openai' }] },
			needsRepickReason: null,
			credentialGap: null,
			detected: [],
		}),
		createAgentSession: async () =>
			fakeAgentSession({
				currentTaskStore: () => {
					state.reads += 1
					return state.store
				},
				resetTaskStore: () => {
					state.store = undefined
					state.resets += 1
				},
				send: async function* () {
					state.sends += 1
					yield { kind: 'done' }
				},
			}),
	}
})

const { App } = await import('../App.js')
let mounted: ReturnType<typeof render> | undefined
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(() => {
	mounted?.unmount()
	mounted = undefined
	state.store = undefined
	state.sends = 0
	state.resets = 0
	state.reads = 0
})

async function waitFor(text: string) {
	const started = performance.now()
	while (!mounted?.frames.join('\n').includes(text) && performance.now() - started < 3000)
		await tick()
	expect(mounted?.frames.join('\n')).toContain(text)
}

async function submit(command: string) {
	mounted?.stdin.write(command)
	await tick()
	mounted?.stdin.write('\r')
	await tick()
}

it('reads the actual current task store without a model call and clears it on a new conversation', async () => {
	mounted = render(<App ctx={{ cwd: '/work/tasks-command', version: 'test' }} />)
	await waitFor('Connected to mock')
	await tick(80)
	await submit('/tasks')
	await waitFor('No task list is available yet for this conversation.')

	state.store = new InMemoryTaskStore()
	await submit('/tasks')
	await waitFor('Tasks: none.')

	const task = await state.store.create({
		runId: generateRunId(),
		tenantId,
		subject: 'Check the real task store',
		owner: 'reviewer',
	})
	// No task events were emitted by the session. Only the actual store knows this row.
	mounted.stdin.write('/tasks')
	await tick()
	await state.store.update(task.id, { status: 'in_progress' })
	mounted.stdin.write('\r')
	await waitFor('Check the real task store')
	expect(mounted.frames.join('\n')).toContain('in_progress')
	expect(mounted.frames.join('\n')).toContain('reviewer')
	expect(state.sends).toBe(0)

	await submit('/new')
	expect(state.resets).toBe(1)
	expect(state.store).toBeUndefined()
	const readsBefore = state.reads
	await submit('/tasks')
	expect(state.reads).toBeGreaterThan(readsBefore)
	await waitFor('No task list is available yet for this conversation.')
	expect(state.sends).toBe(0)
})
