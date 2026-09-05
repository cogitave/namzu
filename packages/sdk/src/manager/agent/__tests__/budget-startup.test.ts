import { getEventListeners } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import type { WorkspaceBackendDriver } from '../../../session/workspace/driver.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { RunEvent } from '../../../types/run/events.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import { ZERO_COST } from '../../../utils/cost.js'
import {
	generateRunId,
	generateSummaryId,
	generateTenantId,
	generateWorkspaceId,
} from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

const managers: AgentManager[] = []
afterEach(() => {
	for (const manager of managers.splice(0)) manager.dispose()
})

async function harness(configBuilder: NonNullable<AgentDefinition['configBuilder']>) {
	const tenantId = generateTenantId()
	const store = new InMemorySessionStore()
	const topicStore = new InMemoryTopicStore()
	const project = await store.createProject({ name: 'budget-startup', tenantId }, tenantId)
	const topic = await topicStore.createTopic({ title: 'work', projectId: project.id }, tenantId)
	const actor: ActorRef = {
		kind: 'user',
		userId: fixtureId.user('operator'),
		tenantId,
	}
	const parent = await store.createSession(
		{ topicId: topic.id, projectId: project.id, currentActor: actor },
		tenantId,
	)
	const workspace: WorkspaceRef = {
		id: generateWorkspaceId(),
		createdAt: new Date(),
		meta: {
			backend: 'git-worktree',
			repoRoot: '/tmp/budget-startup',
			branch: 'child',
			worktreePath: '/tmp/budget-startup/child',
		},
	}
	const disposeWorkspace = vi.fn(async (_ref: WorkspaceRef) => {})
	const backend: WorkspaceBackendDriver = {
		kind: 'git-worktree',
		create: vi.fn(async () => workspace),
		branch: async () => workspace,
		dispose: disposeWorkspace,
		inspect: async () => ({
			exists: true,
			currentRef: 'child',
			isDirty: false,
		}),
	}
	const workspaceRegistry = new WorkspaceBackendRegistry()
	workspaceRegistry.register(backend)
	const run = vi.fn(
		async (_input: unknown, _config: BaseAgentConfig): Promise<BaseAgentResult> => ({
			runId: generateRunId(),
			status: 'completed',
			usage: { ...EMPTY_TOKEN_USAGE, totalTokens: 20, completionTokens: 20 },
			cost: { ...ZERO_COST },
			iterations: 1,
			durationMs: 1,
			messages: [],
			result: 'finished',
		}),
	)
	const capabilities = {
		supportsTools: false,
		supportsStreaming: false,
		supportsConcurrency: false,
		supportsSubAgents: false,
	}
	const metadata = {
		id: 'worker',
		name: 'Worker',
		version: '1.0.0',
		category: 'test',
		description: 'Worker',
	}
	const agent: Agent<BaseAgentConfig, BaseAgentResult> = {
		type: 'reactive',
		metadata: { ...metadata, type: 'reactive', capabilities },
		run,
		cancel: async () => {},
		getCapabilities: () => capabilities,
	}
	const registry = new AgentRegistry()
	registry.register({
		info: { ...metadata, tools: [], defaults: { model: 'mock', tokenBudget: 1_000 } },
		typedAgent: agent,
		configBuilder,
	})
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId,
		}),
		workspaceRegistry,
		capacity: new DefaultCapacityValidator(store),
		topicManager: new TopicManager({ topicStore, sessionStore: store }),
	})
	managers.push(manager)
	const context: AgentTaskContext = {
		parentRunId: generateRunId(),
		parentAgentId: 'parent',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 1_000, remaining: 1_000 },
		tenantId,
		topicId: topic.id,
		sessionId: parent.id,
		projectId: project.id,
		parentActor: actor,
	}
	const options: SendMessageOptions = {
		agentId: 'worker',
		input: { messages: [], workingDirectory: '/tmp' },
		parentSessionId: parent.id,
		tenantId,
		projectId: project.id,
		parentActor: actor,
	}
	return {
		manager,
		context,
		options,
		store,
		parent,
		backend,
		workspace,
		disposeWorkspace,
		run,
	}
}

function config(tokenBudget: number): BaseAgentConfig {
	return { model: 'mock', tokenBudget, timeoutMs: 10_000 }
}

async function expectRolledBack(h: Awaited<ReturnType<typeof harness>>) {
	expect(h.run).not.toHaveBeenCalled()
	expect(h.context.budgetTracker.remaining).toBe(1_000)
	expect(getEventListeners(h.context.parentAbortController.signal, 'abort')).toEqual([])
	expect(h.manager.listByParent(h.context.parentRunId)).toEqual([])
	expect(await h.store.getChildren(h.parent.id, h.context.tenantId)).toEqual([])
	expect(await h.store.listSessionsByProject(h.context.projectId, h.context.tenantId)).toEqual([
		h.parent,
	])
	expect(h.disposeWorkspace).toHaveBeenCalledExactlyOnceWith(h.workspace)
}

describe('a child runs inside its reservation', () => {
	it.each([
		{ requested: 0, expected: 500 },
		{ requested: 10_000, expected: 500 },
		{ requested: 100, expected: 100 },
	])('bounds builder budget $requested to $expected', async ({ requested, expected }) => {
		const sharedConfig = config(requested)
		const h = await harness(() => sharedConfig)
		const task = await h.manager.sendMessage(h.options, h.context)
		await h.manager.waitForCompletion(task.taskId)

		expect(h.run.mock.calls[0]?.[1].tokenBudget).toBe(expected)
		expect(sharedConfig).toEqual(config(requested))
		expect(h.context.budgetTracker.remaining).toBe(980)
	})

	it('keeps a caller override below the reservation even when the builder forwards it', async () => {
		const h = await harness((options) => config(options.tokenBudget ?? 0))
		h.options.configOverrides = { tokenBudget: 100_000 }
		const task = await h.manager.sendMessage(h.options, h.context)
		await h.manager.waitForCompletion(task.taskId)
		expect(h.run.mock.calls[0]?.[1].tokenBudget).toBe(500)
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
		'rejects invalid builder budget %s and refunds it',
		async (budget) => {
			const h = await harness(() => config(budget))
			await expect(h.manager.sendMessage(h.options, h.context)).rejects.toThrow(
				'Invalid child token budget',
			)
			await expectRolledBack(h)
		},
	)

	it('refuses a nonfinite allocation before provisioning', async () => {
		const h = await harness(() => config(100))
		h.options.budgetAllocation = { tokenBudget: Number.NaN }
		await expect(h.manager.sendMessage(h.options, h.context)).rejects.toThrow('finite and positive')
		expect(h.backend.create).not.toHaveBeenCalled()
		expect(h.context.budgetTracker.remaining).toBe(1_000)
	})
})

describe('startup owns its resources until the child invocation starts', () => {
	it('rolls back a construction error before the task is registered', async () => {
		const h = await harness(() => config(100))
		const failure = new Error('tool scope could not be resolved')
		Object.defineProperty(h.options, 'toolScope', {
			get: () => {
				throw failure
			},
		})
		await expect(h.manager.sendMessage(h.options, h.context)).rejects.toBe(failure)
		await expectRolledBack(h)
	})

	it('rolls back a rejecting config builder and closes its pending event', async () => {
		const failure = new Error('configuration unavailable')
		const h = await harness(async () => {
			throw failure
		})
		const events: RunEvent[] = []
		await expect(
			h.manager.sendMessage(h.options, h.context, (event) => {
				events.push(event)
			}),
		).rejects.toBe(failure)
		await expectRolledBack(h)
		expect(events.map((event) => event.type)).toEqual([
			'agent_pending',
			'subsession_spawned',
			'agent_failed',
		])
	})

	it.each(['agent_pending', 'subsession_spawned'] as const)(
		'rolls back an asynchronous %s listener failure',
		async (eventType) => {
			const h = await harness(() => config(100))
			const failure = new Error('listener unavailable')
			await expect(
				h.manager.sendMessage(h.options, h.context, async (event) => {
					if (event.type === eventType) throw failure
				}),
			).rejects.toBe(failure)
			await expectRolledBack(h)
		},
	)

	it('does not start a child cancelled while its builder is pending', async () => {
		let release: () => void = () => {}
		const pending = new Promise<void>((resolve) => {
			release = resolve
		})
		let signalEntered: () => void = () => {}
		const entered = new Promise<void>((resolve) => {
			signalEntered = resolve
		})
		const h = await harness(async () => {
			signalEntered()
			await pending
			return config(100)
		})
		const spawning = h.manager.sendMessage(h.options, h.context)
		await entered
		h.manager.cancelAll(h.context.parentRunId)
		release()
		await expect(spawning).rejects.toThrow()
		await expectRolledBack(h)
	})

	it('disposes a created workspace if persisting its reference fails', async () => {
		const h = await harness(() => config(100))
		const failure = new Error('workspace reference write failed')
		vi.spyOn(h.store, 'updateSubSession').mockRejectedValueOnce(failure)
		await expect(h.manager.sendMessage(h.options, h.context)).rejects.toBe(failure)
		await expectRolledBack(h)
	})
})
