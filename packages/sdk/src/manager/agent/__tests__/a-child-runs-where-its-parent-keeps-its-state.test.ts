import { describe, expect, it } from 'vitest'

import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { TokenBudget } from '../../../run/token-budget.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { generateRunId as budgetRunId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A delegated child of a run held in memory runs in memory too.
 *
 * The child config came from a `configBuilder` (or the manager's bare
 * config) with no run store and no path builder, so the child's run built
 * disk stores under `defaultStateRoot()` and left its evidence, checkpoints
 * and history there, although its parent had asked for nothing on disk. The
 * parent's choice now travels on `AgentTaskContext.childStorage` and the
 * manager stamps it after the builder, like the other inherited fields.
 */

const tenant = '0f7c5f1e-6a57-4d0b-9f2e-3d8b0a3c9e11' as TenantId
const actor = (tenantId: TenantId): ActorRef =>
	({
		kind: 'user',
		userId: '5d2a8a94-8a0c-4c61-a3a4-8f5c1c2e7b10',
		tenantId,
	}) as unknown as ActorRef

function recordingAgent(seen: BaseAgentConfig[]): Agent<BaseAgentConfig, BaseAgentResult> {
	return {
		metadata: {
			type: 'reactive',
			id: 'worker',
			name: 'Worker',
			version: '1',
			category: 'test',
			description: 'records its config',
			capabilities: {
				supportsTools: true,
				supportsStreaming: true,
				supportsConcurrency: true,
				supportsSubAgents: false,
			},
		},
		async run(_input: unknown, config: BaseAgentConfig) {
			seen.push(config)
			return {
				runId: '8e0f2c55-2a8b-4a49-9f71-0d7c3e3a2b19' as never,
				status: 'completed',
				usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
				cost: { totalCost: 0 },
				iterations: 1,
				durationMs: 1,
				messages: [],
				result: 'done',
			} as unknown as BaseAgentResult
		},
	} as unknown as Agent<BaseAgentConfig, BaseAgentResult>
}

async function harness(builderConfig?: Partial<BaseAgentConfig>) {
	const seen: BaseAgentConfig[] = []
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryTopicStore()
	const threadManager = new TopicManager({ topicStore: threadStore, sessionStore: store })
	const project = await store.createProject({ tenantId: tenant, name: 'p' }, tenant)
	const thread = await threadStore.createTopic({ projectId: project.id, title: 'mem' }, tenant)
	const parent = await store.createSession(
		{ topicId: thread.id, projectId: project.id, currentActor: actor(tenant) },
		tenant,
	)
	await store.updateSession({ ...parent, status: 'active' }, tenant)

	const registry = new AgentRegistry()
	const agent = recordingAgent(seen)
	const info = {
		name: agent.metadata.name,
		version: agent.metadata.version,
		category: agent.metadata.category,
		description: agent.metadata.description,
		tools: [],
		defaults: { model: 'test', tokenBudget: 1_000 },
	}
	registry.register({ info: { ...info, id: 'worker' }, typedAgent: agent } as never)
	registry.register({
		info: { ...info, id: 'built-worker' },
		typedAgent: agent,
		configBuilder: (opts: Record<string, unknown>) => ({
			model: 'test',
			tokenBudget: (opts.tokenBudget as number) ?? 1_000,
			timeoutMs: (opts.timeoutMs as number) ?? 30_000,
			...builderConfig,
		}),
	} as never)

	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => '3f0f1f4e-1d2c-4b5a-8e9f-0a1b2c3d4e5f' as never,
		}),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager,
	})

	const context = (over: Partial<AgentTaskContext> = {}): AgentTaskContext =>
		({
			parentRunId: '1b7e8f3a-4c2d-4e5f-9a0b-6c7d8e9f0a1b',
			parentAgentId: 'supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budget: TokenBudget.create(100_000, budgetRunId()),
			tenantId: tenant,
			topicId: thread.id,
			sessionId: parent.id,
			projectId: project.id,
			parentActor: actor(tenant),
			...over,
		}) as AgentTaskContext

	const spawn = async (ctx: AgentTaskContext, agentId = 'worker') => {
		await manager.sendMessage(
			{
				agentId,
				input: { messages: [], workingDirectory: '/tmp' },
				parentSessionId: parent.id,
				tenantId: tenant,
				projectId: project.id,
				parentActor: actor(tenant),
			} as SendMessageOptions,
			ctx,
		)
		await new Promise((r) => setTimeout(r, 20))
	}

	return { seen, context, spawn }
}

describe.each([
	['with no configBuilder', 'worker'],
	['with a configBuilder', 'built-worker'],
])('a child of a parent held in memory (%s)', (_label, agentId) => {
	it('gets a run store of its own in memory', async () => {
		const h = await harness()

		await h.spawn(h.context({ childStorage: { kind: 'memory' } }), agentId)

		expect(h.seen[0]?.runStore).toBeInstanceOf(InMemoryRunStore)
		expect(h.seen[0]?.checkpointStore).toBeUndefined()
	})

	it("gets the parent's checkpoint store when the parent named one", async () => {
		const h = await harness()
		const checkpointStore = new InMemoryCheckpointStore()

		await h.spawn(h.context({ childStorage: { kind: 'memory', checkpointStore } }), agentId)

		expect(h.seen[0]?.runStore).toBeInstanceOf(InMemoryRunStore)
		expect(h.seen[0]?.checkpointStore).toBe(checkpointStore)
	})

	it('a fresh run store per child, never a shared one', async () => {
		const h = await harness()
		const ctx = h.context({ childStorage: { kind: 'memory' } })

		await h.spawn(ctx, agentId)
		await h.spawn(ctx, agentId)

		expect(h.seen).toHaveLength(2)
		expect(h.seen[0]?.runStore).not.toBe(h.seen[1]?.runStore)
	})
})

describe('what the parent did not choose is left alone', () => {
	it('a parent with no storage choice leaves the child to its own config', async () => {
		const h = await harness()

		await h.spawn(h.context(), 'built-worker')

		expect(h.seen[0]?.runStore).toBeUndefined()
	})

	it('a builder that names a path builder keeps it', async () => {
		const pathBuilder = new DefaultPathBuilder('/tmp/namzu-child-root')
		const h = await harness({ pathBuilder })

		await h.spawn(h.context({ childStorage: { kind: 'memory' } }), 'built-worker')

		expect(h.seen[0]?.pathBuilder).toBe(pathBuilder)
		expect(h.seen[0]?.runStore).toBeUndefined()
	})

	it('a builder that names a run store keeps it', async () => {
		const runStore = new InMemoryRunStore()
		const h = await harness({ runStore })

		await h.spawn(h.context({ childStorage: { kind: 'memory' } }), 'built-worker')

		expect(h.seen[0]?.runStore).toBe(runStore)
	})
})
