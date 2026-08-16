import { describe, expect, it } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { fixtureId } from '../../../test-support/ids.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { AgentId, TenantId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A restriction a descendant can shed by delegating is not a restriction.
 *
 * NZ-GATE-09 let a spawn narrow its child's tool grant, and the scope
 * stopped at exactly one level: a child denied `bash` could spawn a
 * grandchild naming no scope of its own, and the grandchild got `bash`
 * back. Every meaningful confinement is one delegation deep, so that is the
 * whole guarantee gone — quietly, and in the direction of more access.
 *
 * The union travels on `AgentTaskContext`, alongside the depth and the
 * budget, which are the two other facts that have always had to survive a
 * spawn for the same reason.
 */

const TENANT = 'tnt_widen' as TenantId

/** Records every config it is run with, in spawn order. */
function recordingAgent(seen: { configs: BaseAgentConfig[]; contexts: AgentTaskContext[] }) {
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
			seen.configs.push(config)
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

function definition(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
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
			({ model: 'test', tokenBudget: 1_000, timeoutMs: 10_000 }) as BaseAgentConfig,
	} as AgentDefinition
}

/**
 * Spawns a chain of depth `denies.length`, each level naming its own scope,
 * and returns what each level was actually granted.
 */
async function spawnChain(denies: (readonly string[] | undefined)[]): Promise<{
	configs: BaseAgentConfig[]
	recorded: (readonly string[] | undefined)[]
}> {
	const seen = { configs: [] as BaseAgentConfig[], contexts: [] as AgentTaskContext[] }
	const store = new InMemorySessionStore()
	const topicStore = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
	const topic = await topicStore.createTopic({ projectId: project.id, title: 't' }, TENANT)
	const rootActor = { kind: 'agent', agentId: 'sup' as AgentId, tenantId: TENANT } as const
	const parentSession = await store.createSession(
		{ topicId: topic.id, projectId: project.id, currentActor: rootActor },
		TENANT,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, TENANT)

	const registry = new AgentRegistry()
	registry.register(definition(recordingAgent(seen)))

	let n = 0
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		threadManager: new TopicManager({ topicStore, sessionStore: store }),
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		summaryMaterializer: new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => `sum_${++n}` as SummaryId,
		}),
	})

	let context: AgentTaskContext = {
		parentRunId: 'run_root' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: TENANT,
		topicId: topic.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor: rootActor,
	} as AgentTaskContext

	const recorded: (readonly string[] | undefined)[] = []
	for (const deny of denies) {
		const task = await manager.sendMessage(
			{
				agentId: 'worker',
				input: { messages: [], workingDirectory: '/tmp' } as never,
				parentSessionId: context.sessionId,
				tenantId: TENANT,
				projectId: project.id,
				parentActor: context.parentActor,
				...(deny ? { toolScope: { deny: [...deny] } } : {}),
			} as never,
			context,
		)
		await manager.waitForCompletion(task.taskId)
		recorded.push(manager.getSpawnRecord(task.taskId)?.resolvedToolDenies)
		// The next level spawns from the child's own context, exactly as a
		// running child does when it delegates.
		context = task.context
	}

	return { configs: seen.configs, recorded }
}

describe('a tool scope cannot be widened by delegating further down', () => {
	it('keeps a denial the grandchild never named', async () => {
		// The hole this closes. Depth 1 denies `bash`; depth 2 names no scope
		// at all and used to get it back.
		const { configs } = await spawnChain([['bash'], undefined])

		expect(configs[0]?.deniedTools).toEqual(['bash'])
		expect(configs[1]?.deniedTools).toEqual(['bash'])
	})

	it('lets a descendant narrow further, and keeps both', async () => {
		// Union, not "innermost wins" and not "outermost wins" — each of
		// those satisfies the case above and fails this one.
		const { configs } = await spawnChain([['bash'], ['write_file']])

		expect(configs[0]?.deniedTools).toEqual(['bash'])
		expect(configs[1]?.deniedTools?.slice().sort()).toEqual(['bash', 'write_file'])
	})

	it('carries a denial across two levels that name nothing', async () => {
		// Depth 1 restricts; depths 2 and 3 are ordinary delegations. A scope
		// that survives one hop and not two is not a confinement either.
		const { configs } = await spawnChain([['bash'], undefined, undefined])

		expect(configs[2]?.deniedTools).toEqual(['bash'])
	})

	it('does not invent a denial for a chain that never had one', async () => {
		const { configs } = await spawnChain([undefined, undefined])

		expect(configs[0]?.deniedTools).toBeUndefined()
		expect(configs[1]?.deniedTools).toBeUndefined()
	})

	it('records what each level was granted, so it can be read rather than inferred', async () => {
		// Behaviour tests answer "was the call refused". This answers "what
		// was this child actually allowed" — which is the question an
		// operator reading a spawn record has, and the one that distinguishes
		// a correct grant from a coincidentally correct refusal.
		const { recorded } = await spawnChain([['bash'], ['write_file']])

		expect(recorded[0]).toEqual(['bash'])
		expect(recorded[1]?.slice().sort()).toEqual(['bash', 'write_file'])
	})

	it('does not duplicate a denial named twice down the chain', async () => {
		const { configs } = await spawnChain([['bash'], ['bash']])

		expect(configs[1]?.deniedTools).toEqual(['bash'])
	})
})
