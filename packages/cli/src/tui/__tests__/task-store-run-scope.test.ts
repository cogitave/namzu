import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type CreateTaskParams,
	type Message,
	type RunId,
	type Task,
	type TaskStore,
	createUserMessage,
	generateCheckpointId,
	generateRunId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { openSessions, startConversation } from '../../integrations/sessions/store.js'

const tasks: { runId: RunId; store: TaskStore; task: Task }[] = []

function createWithDefaultRun(store: TaskStore, subject: string): Promise<Task> {
	// Typed SDK callers provide runId. Exercise DiskTaskStore's fallback for
	// JavaScript callers that omit it without weakening the production contract.
	const create = store.create as (params: Omit<CreateTaskParams, 'runId'>) => Promise<Task>
	return create.call(store, { subject })
}

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: { runId: RunId; taskStore: TaskStore; messages: readonly Message[] }) =>
			(async function* () {
				yield { type: 'run_started', runId: params.runId }
				const task = await createWithDefaultRun(params.taskStore, 'fresh task')
				tasks.push({ runId: params.runId, store: params.taskStore, task })
			})(),
		resumeRun: async (params: { scope: { runId: RunId }; taskStore: TaskStore }) => {
			const task = await createWithDefaultRun(params.taskStore, 'resumed task')
			tasks.push({ runId: params.scope.runId, store: params.taskStore, task })
			return { resumed: true, run: {}, state: {} }
		},
	}
})

const roots: string[] = []
afterEach(() => {
	tasks.length = 0
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('keeps default task ownership and listing with the actual fresh or resumed run', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-task-run-cwd-'))
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-task-run-state-'))
	roots.push(cwd, stateRoot)
	const conversations = await openSessions(cwd, { stateRoot })
	const sessionId = await startConversation(conversations)
	const scope = {
		sessionId,
		projectId: conversations.projectId,
		topicId: conversations.topicId,
		tenantId: conversations.tenantId,
	}
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'anthropic' }],
		subagents: { active: [] },
	}
	const detected = [
		{
			entry: {
				id: 'anthropic',
				label: 'Anthropic',
				defaultModel: 'claude-sonnet-4-5',
				requiresApiKey: true,
				envVars: ['ANTHROPIC_API_KEY'],
			},
			source: 'env',
			apiKey: 'sk-ant-not-a-real-key',
			alternatives: [],
		} as unknown as DetectedProvider,
	]
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, { cwd, stateRoot, scope })
	const reservedRunId = generateRunId()
	try {
		await Promise.all(
			[reservedRunId, undefined].map(async (runId) => {
				for await (const event of session.send(
					[createUserMessage('plan this work')],
					runId ? { runId } : {},
				)) {
					if (event.kind === 'error') throw new Error(event.message)
				}
			}),
		)
		expect(tasks).toHaveLength(2)
		expect(new Set(tasks.map((entry) => entry.runId)).size).toBe(2)
		for (const entry of tasks) {
			expect(entry.task.runId).toBe(entry.runId)
			expect(entry.task.tenantId).toBe(scope.tenantId)
			expect(await entry.store.list()).toMatchObject([
				{ id: entry.task.id, runId: entry.runId, tenantId: scope.tenantId },
			])
			expect(
				existsSync(
					join(
						conversations.projectStateRoot,
						'tenants',
						scope.tenantId,
						'tasks',
						entry.runId,
						`${entry.task.id}.json`,
					),
				),
			).toBe(true)
		}

		for await (const event of session.resumePaused({
			runId: reservedRunId,
			checkpointId: generateCheckpointId(),
		})) {
			if (event.kind === 'error') throw new Error(event.message)
		}
		const resumed = tasks.at(-1)
		expect(resumed?.runId).toBe(reservedRunId)
		expect(resumed?.task.runId).toBe(reservedRunId)
		expect((await resumed?.store.list())?.map((task) => task.subject)).toEqual([
			'fresh task',
			'resumed task',
		])
	} finally {
		await session.close()
	}
})
