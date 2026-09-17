import { describe, expect, it } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { TokenBudget } from '../../../run/token-budget.js'
import { toolResultCorrespondenceGuardrail } from '../../../runtime/query/guardrail-presets.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { fixtureId, fixtureUuid } from '../../../test-support/ids.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { ToolResultGuardrailSpec } from '../../../types/guardrail/index.js'
import type { AgentId, TenantId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { generateRunId as budgetRunId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * `BaseAgentConfig.toolResultGuardrails` says the screens apply "in this agent
 * and in the agents it delegates to", and until now the kernel did not do the
 * second half.
 *
 * A child is a fresh run with its own executor, which installs
 * `DEFAULT_TOOL_RESULT_GUARDRAILS` whenever nothing said otherwise — so a
 * parent that turned the screens off with `[]`, or substituted a screen with
 * its own `passthroughTools`, had that decision revert the moment it
 * delegated, in the half of its work it does not watch. The failure is silent
 * in both directions: a child screened where the host said none, or
 * unscreened where the host asked for one.
 *
 * This is the fourth field to go the same way as `parentSpan`, `resumeHandler`
 * and `env` — see `an-env-reaches-the-child-it-was-set-for`, whose shape this
 * follows deliberately, including the reason for driving the real
 * `AgentManager`: a test that re-implements the merge proves the merge agrees
 * with itself, and what has to hold is that the manager applies it.
 */

const TENANT = '33fc383e-e313-4cb9-b631-111dd8ebaa3f' as TenantId

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
				runId: fixtureId.run('child'),
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

/** A definition WITH a configBuilder — the shape every real host registers. */
function definitionWithBuilder(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
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
			}) as BaseAgentConfig,
	} as AgentDefinition
}

/** A definition with none, which lands on the manager's other branch. */
function definitionWithoutBuilder(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
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
	} as AgentDefinition
}

async function spawnWith(options: {
	readonly inherited?: readonly ToolResultGuardrailSpec[]
	readonly override?: readonly ToolResultGuardrailSpec[]
	readonly withBuilder?: boolean
}): Promise<BaseAgentConfig | undefined> {
	const seen: { config?: BaseAgentConfig } = {}
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
	const thread = await threadStore.createTopic({ projectId: project.id, title: 't' }, TENANT)
	const parentActor = {
		kind: 'agent',
		agentId: 'sup' as AgentId,
		tenantId: TENANT,
	} as const
	const parentSession = await store.createSession(
		{ topicId: thread.id, projectId: project.id, currentActor: parentActor },
		TENANT,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, TENANT)

	const registry = new AgentRegistry()
	const definition =
		options.withBuilder === false
			? definitionWithoutBuilder(recordingAgent(seen))
			: definitionWithBuilder(recordingAgent(seen))
	registry.register(definition)

	let n = 0
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		threadManager: new TopicManager({
			topicStore: threadStore,
			sessionStore: store,
		}),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => fixtureUuid(`sum_${++n}`) as SummaryId,
		}),
	})

	const context: AgentTaskContext = {
		parentRunId: 'c0250b29-330b-445f-b11d-2926ffd9059c' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budget: TokenBudget.create(100_000, budgetRunId()),
		tenantId: TENANT,
		topicId: thread.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor,
		...(options.inherited ? { toolResultGuardrails: options.inherited } : {}),
	} as AgentTaskContext

	const task = await manager.sendMessage(
		{
			agentId: 'worker',
			input: { messages: [], workingDirectory: '/tmp' } as never,
			parentSessionId: parentSession.id,
			tenantId: TENANT,
			projectId: project.id,
			parentActor,
			...(options.override ? { configOverrides: { toolResultGuardrails: options.override } } : {}),
		} as never,
		context,
	)

	await manager.waitForCompletion(task.taskId)
	return seen.config
}

const NONE: readonly ToolResultGuardrailSpec[] = Object.freeze([])

describe('the screens a parent run chose', () => {
	it('reach a child whose configBuilder never heard of them', async () => {
		const config = await spawnWith({
			inherited: [
				toolResultCorrespondenceGuardrail({
					passthroughTools: ['mcp_weather-co_lookup'],
				}),
			],
		})

		expect(config?.toolResultGuardrails?.[0]).toMatchObject({
			name: 'tool-result-correspondence',
		})
	})

	it('carry an EMPTY list as a decision rather than as an absence', async () => {
		// The case a truthiness test would get wrong, and the one that matters
		// most: `[]` is the host turning the screens off, so a child that
		// installed the shipped default here would screen exactly what its
		// parent said not to.
		const config = await spawnWith({ inherited: NONE })

		expect(config?.toolResultGuardrails).toEqual([])
	})

	it('reach a child built on the manager’s other branch too', async () => {
		// The bare-config branch lists every field it carries by hand, so one
		// omitted field is one the child does not get — the shape of the `env`
		// defect this mirrors.
		const config = await spawnWith({ inherited: NONE, withBuilder: false })

		expect(config?.toolResultGuardrails).toEqual([])
	})

	it('are left to the default when the parent stated none', async () => {
		// Not `[]`. Absent means the parent configured nothing, and the child
		// installs the shipped default exactly as any other run does.
		const config = await spawnWith({})

		expect(config?.toolResultGuardrails).toBeUndefined()
	})

	it('are replaced by an explicit override, including with none', async () => {
		// A host can still hand one child a different set — that is what
		// `configOverrides` is for — and the override wins over the inherited
		// value rather than merging with it.
		const config = await spawnWith({
			inherited: NONE,
			override: [toolResultCorrespondenceGuardrail()],
		})

		expect(config?.toolResultGuardrails).toHaveLength(1)
		expect(config?.toolResultGuardrails?.[0]).toMatchObject({
			name: 'tool-result-correspondence',
		})
	})
})
