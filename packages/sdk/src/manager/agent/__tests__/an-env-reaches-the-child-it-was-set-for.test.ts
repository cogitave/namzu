import { describe, expect, it } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore as InMemoryThreadStore } from '../../../store/topic/memory.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { AgentId, TenantId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { TopicManager as ThreadManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A delegate registered the normal way inherited no environment at all.
 *
 * `AgentManager` builds a child's config on two branches. The bare-config
 * branch — taken only when a definition has NO `configBuilder` — has always
 * carried `env`. The `configBuilder` branch, which is what a host registering
 * a real agent actually uses, never stamped it. So a run given an environment
 * handed its delegates none of it.
 *
 * This is the third field to go the same way: `parentSpan` and `resumeHandler`
 * are both stamped after the builder returns, each with a comment saying the
 * builder is written by whoever registered the agent and cannot be expected to
 * forward something it was never told about. `env` was missed, and it went
 * unnoticed because a missing environment does not fail — the child just runs
 * somewhere else.
 *
 * These drive the real `AgentManager` rather than re-implementing the merge.
 * A test that restates the logic proves the logic agrees with itself; what has
 * to hold is that the manager applies it.
 */

const TENANT = 'tnt_env' as TenantId

/** Records the config it is run with, so the assertion is on what shipped. */
function recordingAgent(seen: { config?: BaseAgentConfig }) {
	return {
		type: 'reactive',
		metadata: {
			id: 'worker',
			name: 'worker',
			version: '1.0.0',
			category: 'general',
			description: 'records its config',
			type: 'reactive',
			capabilities: {},
		},
		async run(_input: unknown, config: BaseAgentConfig): Promise<BaseAgentResult> {
			seen.config = config
			return {
				runId: 'run_child',
				status: 'completed',
				result: 'ok',
				usage: { ...EMPTY_TOKEN_USAGE },
				cost: { ...ZERO_COST },
				iterations: 1,
				durationMs: 0,
				messages: [],
			} as BaseAgentResult
		},
		async cancel() {},
		getCapabilities() {
			return {} as never
		},
	} as unknown as Agent<BaseAgentConfig, BaseAgentResult>
}

/** A definition WITH a configBuilder — the branch that dropped `env`. */
function definitionWithBuilder(
	agent: Agent<BaseAgentConfig, BaseAgentResult>,
	builderEnv?: Record<string, string>,
): AgentDefinition {
	return {
		info: {
			id: 'worker',
			name: 'worker',
			version: '1.0.0',
			category: 'general',
			description: 'a worker',
			tools: [],
			defaults: { model: 'test', tokenBudget: 1_000 },
		},
		typedAgent: agent,
		configBuilder: () =>
			({
				model: 'test',
				tokenBudget: 1_000,
				timeoutMs: 10_000,
				...(builderEnv ? { env: builderEnv } : {}),
			}) as BaseAgentConfig,
	} as AgentDefinition
}

async function spawnWith(options: {
	builderEnv?: Record<string, string>
	overrideEnv?: Record<string, string>
}): Promise<BaseAgentConfig | undefined> {
	const seen: { config?: BaseAgentConfig } = {}
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()
	const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
	const thread = await threadStore.createTopic({ projectId: project.id, title: 't' }, TENANT)
	const parentActor = { kind: 'agent', agentId: 'sup' as AgentId, tenantId: TENANT } as const
	const parentSession = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: parentActor },
		TENANT,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, TENANT)

	const registry = new AgentRegistry()
	registry.register(definitionWithBuilder(recordingAgent(seen), options.builderEnv))

	let n = 0
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		threadManager: new ThreadManager({ topicStore: threadStore, sessionStore: store }),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => `sum_${++n}` as SummaryId,
		}),
	})

	const context: AgentTaskContext = {
		parentRunId: 'run_parent' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: TENANT,
		threadId: thread.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor,
	} as AgentTaskContext

	const task = await manager.sendMessage(
		{
			agentId: 'worker',
			input: { messages: [], workingDirectory: '/tmp' } as never,
			parentSessionId: parentSession.id,
			tenantId: TENANT,
			projectId: project.id,
			parentActor,
			...(options.overrideEnv ? { configOverrides: { env: options.overrideEnv } } : {}),
		} as never,
		context,
	)

	await manager.waitForCompletion(task.taskId)
	return seen.config
}

describe('an environment survives a configBuilder that never heard of it', () => {
	it('reaches a child whose builder sets none', async () => {
		const config = await spawnWith({ overrideEnv: { API_BASE: 'https://staging' } })

		expect(config?.env).toEqual({ API_BASE: 'https://staging' })
	})

	it('keeps the builder keys the caller did not restate', async () => {
		// Why this is a merge and not an assignment: `configOverrides` is a
		// Partial, so replacing the map would drop everything the builder set,
		// and a caller overriding one variable is not saying the rest should
		// vanish.
		const config = await spawnWith({
			builderEnv: { REGION: 'eu', TIER: 'free' },
			overrideEnv: { TIER: 'paid' },
		})

		expect(config?.env).toEqual({ REGION: 'eu', TIER: 'paid' })
	})

	it('leaves the builder environment alone when nothing overrides it', async () => {
		const config = await spawnWith({ builderEnv: { REGION: 'eu' } })

		expect(config?.env).toEqual({ REGION: 'eu' })
	})

	it('gives a child with no environment undefined rather than an empty map', async () => {
		// An agent that never had an environment must not gain an empty object
		// that every reader then has to tell apart from a real one.
		const config = await spawnWith({})

		expect(config?.env).toBeUndefined()
	})
})
