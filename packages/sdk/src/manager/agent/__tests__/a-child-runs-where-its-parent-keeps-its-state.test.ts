import { describe, expect, it } from 'vitest'

import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { InMemorySessionCheckpointStore } from '../../../store/checkpoint/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { TenantId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A child session of a parent held in memory runs in memory too.
 *
 * The child config came from a `configBuilder` (or the manager's bare
 * config) with no session log and no paths, so the child would have opened a
 * disk log under `NAMZU_HOME` although its parent had asked for nothing on
 * disk. The parent's choice travels on `AgentTaskContext.childStorage` and
 * the manager stamps it after the builder, like the other inherited fields.
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
				sessionId: config.sessionId,
				turnId: generateTurnId(),
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
			parentSessionId: parent.id,
			parentTurnId: generateTurnId(),
			parentAgentId: 'supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budget: SessionTokenBudget.create(100_000, {
				rootSessionId: generateSessionId(),
				rootTurnId: generateTurnId(),
			}),
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
	it('gets a session log of its own in memory, for its own session', async () => {
		const h = await harness()

		await h.spawn(h.context({ childStorage: { kind: 'memory' } }), agentId)

		expect(h.seen[0]?.sessionLog).toBeInstanceOf(InMemorySessionLog)
		expect(h.seen[0]?.sessionLog?.sessionId).toBe(h.seen[0]?.sessionId)
		expect(h.seen[0]?.checkpointStore).toBeUndefined()
	})

	it("gets the parent's checkpoint store when the parent named one", async () => {
		const h = await harness()
		// Only its identity is under test; the log view is never consulted.
		const checkpointStore = new InMemorySessionCheckpointStore({
			log: {
				verifyThrough: async () => true,
				writtenDocSha256: async () => null,
				openDecisionCheckpoints: async () => [],
			},
		})

		await h.spawn(h.context({ childStorage: { kind: 'memory', checkpointStore } }), agentId)

		expect(h.seen[0]?.sessionLog).toBeInstanceOf(InMemorySessionLog)
		expect(h.seen[0]?.checkpointStore).toBe(checkpointStore)
	})

	it('a fresh log per child, never a shared one', async () => {
		const h = await harness()
		const ctx = h.context({ childStorage: { kind: 'memory' } })

		await h.spawn(ctx, agentId)
		await h.spawn(ctx, agentId)

		expect(h.seen).toHaveLength(2)
		expect(h.seen[0]?.sessionLog).not.toBe(h.seen[1]?.sessionLog)
	})
})

describe('what the parent did not choose is left alone', () => {
	it('a parent with no storage choice leaves the child to its own config', async () => {
		const h = await harness()

		await h.spawn(h.context(), 'built-worker')

		expect(h.seen[0]?.sessionLog).toBeUndefined()
	})

	it('a builder that names a session log keeps it', async () => {
		const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() })
		const h = await harness({ sessionLog })

		await h.spawn(h.context({ childStorage: { kind: 'memory' } }), 'built-worker')

		expect(h.seen[0]?.sessionLog).toBe(sessionLog)
	})
})
