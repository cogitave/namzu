import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	type SessionId,
	type Task,
	type TaskStore,
	type TurnId,
	createUserMessage,
	generateCheckpointId,
	generateSessionId,
	generateTurnId,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { DetectedProvider, Preferences } from '../../integrations/providers/index.js'
import { openSessions, startConversation } from '../../integrations/sessions/store.js'

/**
 * A plan belongs to the conversation, not to one turn: tasks live under
 * `<session-id>/tasks/`, each records the turn that created it, and a later
 * turn — or the same turn resumed — reads and extends the same list.
 */

const tasks: { turnId: TurnId; store: TaskStore; task: Task }[] = []

async function createTask(
	store: TaskStore,
	sessionId: SessionId,
	turnId: TurnId,
	subject: string,
): Promise<Task> {
	return await store.create({ sessionId, turnId, subject })
}

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: {
			sessionId: SessionId
			turnId: TurnId
			taskStore: TaskStore
			messages: readonly Message[]
		}) =>
			(async function* () {
				yield { type: 'turn_started', sessionId: params.sessionId, turnId: params.turnId }
				const task = await createTask(
					params.taskStore,
					params.sessionId,
					params.turnId,
					'fresh task',
				)
				tasks.push({ turnId: params.turnId, store: params.taskStore, task })
			})(),
		resumeSession: async (params: {
			scope: { sessionId: SessionId; turnId: TurnId }
			taskStore: TaskStore
		}) => {
			const task = await createTask(
				params.taskStore,
				params.scope.sessionId,
				params.scope.turnId,
				'resumed task',
			)
			tasks.push({ turnId: params.scope.turnId, store: params.taskStore, task })
			return { resumed: true, turn: {}, state: {} }
		},
	}
})

const roots: string[] = []
afterEach(() => {
	tasks.length = 0
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('keeps one task list per conversation, each task naming the turn that created it', async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-task-session-cwd-'))
	const stateRoot = mkdtempSync(join(tmpdir(), 'namzu-task-session-state-'))
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
	const session = await createAgentSession(preferences, detected, {
		cwd,
		stateRoot,
		scope,
		conversationSessions: conversations,
	})
	const reservedTurnId = generateTurnId()
	try {
		expect(session.currentTaskStore?.()).toBeUndefined()
		for (const turnId of [reservedTurnId, undefined]) {
			for await (const event of session.send(
				[createUserMessage('plan this work')],
				turnId ? { turnId } : {},
			)) {
				if (event.kind === 'error') throw new Error(event.message)
			}
		}
		expect(tasks).toHaveLength(2)
		expect(new Set(tasks.map((entry) => entry.turnId)).size).toBe(2)
		expect(tasks[0]?.turnId).toBe(reservedTurnId)
		for (const entry of tasks) {
			expect(entry.task.turnId).toBe(entry.turnId)
			expect(entry.task.sessionId).toBe(sessionId)
			expect(
				existsSync(join(conversations.paths.tasks({ sessionId }), `${entry.task.id}.json`)),
			).toBe(true)
		}
		// Both turns wrote to the conversation's one list.
		expect((await tasks.at(-1)?.store.list())?.map((task) => task.subject)).toEqual([
			'fresh task',
			'fresh task',
		])

		for await (const event of session.resumePaused({
			turnId: reservedTurnId,
			checkpointId: generateCheckpointId(),
		})) {
			if (event.kind === 'error') throw new Error(event.message)
		}
		const resumed = tasks.at(-1)
		expect(session.currentTaskStore?.()).toBe(resumed?.store)
		expect(resumed?.turnId).toBe(reservedTurnId)
		expect(resumed?.task.turnId).toBe(reservedTurnId)
		expect(await resumed?.store.list()).toHaveLength(3)

		// Moving away and back must not resurrect a previously selected store.
		const previousConversation = scope.sessionId
		scope.sessionId = generateSessionId()
		expect(session.currentTaskStore?.()).toBeUndefined()
		scope.sessionId = previousConversation
		expect(session.currentTaskStore?.()).toBeUndefined()
		session.resetTaskStore?.()
		expect(session.currentTaskStore?.()).toBeUndefined()
	} finally {
		await session.close()
	}
})
