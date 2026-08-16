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
import type { AgentPersona } from '../../../types/persona/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A supervisor handing out a read-only subtask could not say so.
 *
 * `SendMessageOptions` carried no way to narrow what the child may use, so
 * a research delegation given to an agent whose definition also grants
 * `write` and `bash` ran with all of them. The scope had to reach the
 * child's config, and this is the seam where a child's config is built.
 *
 * Deny rather than allow, because the delegating side does not know what
 * the child has: enumerating an agent's whole tool set in order to remove
 * one from it pins that list against an agent that later gains a tool —
 * silently, and in the direction of MORE access.
 *
 * These drive the real `AgentManager` rather than re-implementing the
 * stamp. What has to hold is that the manager applies it, on both of the
 * branches it builds a config on.
 */

const TENANT = 'tnt_scope' as TenantId

const PERSONA = (role: string): AgentPersona =>
	({ identity: { role, name: role } }) as unknown as AgentPersona

/** Records the config it is run with, so the assertion is on what shipped. */
function recordingAgent(seen: { configs: BaseAgentConfig[] }) {
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

function definition(
	agent: Agent<BaseAgentConfig, BaseAgentResult>,
	opts: {
		readonly withBuilder: boolean
		readonly builderDenies?: readonly string[]
		readonly builderPersona?: AgentPersona
	},
): AgentDefinition {
	const base = {
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
	}
	if (!opts.withBuilder) return base as AgentDefinition

	return {
		...base,
		// Returns a FIXED config and ignores every key it was handed. This is
		// what most real builders do, and it is the whole reason the stamp
		// has to happen after this returns rather than before.
		configBuilder: () =>
			({
				model: 'test',
				tokenBudget: 1_000,
				timeoutMs: 10_000,
				...(opts.builderDenies ? { deniedTools: [...opts.builderDenies] } : {}),
				...(opts.builderPersona ? { persona: opts.builderPersona } : {}),
			}) as BaseAgentConfig,
	} as AgentDefinition
}

/** Spawns one child per entry in `spawns`, returning each config as it shipped. */
async function spawn(opts: {
	readonly withBuilder?: boolean
	readonly builderDenies?: readonly string[]
	readonly builderPersona?: AgentPersona
	readonly spawns: readonly {
		readonly deny?: readonly string[]
		readonly personaOverride?: AgentPersona
	}[]
}): Promise<BaseAgentConfig[]> {
	const seen: { configs: BaseAgentConfig[] } = { configs: [] }
	const store = new InMemorySessionStore()
	const topicStore = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
	const topic = await topicStore.createTopic({ projectId: project.id, title: 't' }, TENANT)
	const parentActor = { kind: 'agent', agentId: 'sup' as AgentId, tenantId: TENANT } as const
	const parentSession = await store.createSession(
		{ topicId: topic.id, projectId: project.id, currentActor: parentActor },
		TENANT,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, TENANT)

	const registry = new AgentRegistry()
	registry.register(
		definition(recordingAgent(seen), {
			withBuilder: opts.withBuilder ?? true,
			...(opts.builderDenies ? { builderDenies: opts.builderDenies } : {}),
			...(opts.builderPersona ? { builderPersona: opts.builderPersona } : {}),
		}),
	)

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

	const context: AgentTaskContext = {
		parentRunId: 'run_parent' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: TENANT,
		topicId: topic.id,
		sessionId: parentSession.id,
		projectId: project.id,
		parentActor,
	} as AgentTaskContext

	for (const s of opts.spawns) {
		const task = await manager.sendMessage(
			{
				agentId: 'worker',
				input: { messages: [], workingDirectory: '/tmp' } as never,
				parentSessionId: parentSession.id,
				tenantId: TENANT,
				projectId: project.id,
				parentActor,
				...(s.deny ? { toolScope: { deny: [...s.deny] } } : {}),
				...(s.personaOverride ? { personaOverride: s.personaOverride } : {}),
			} as never,
			context,
		)
		await manager.waitForCompletion(task.taskId)
	}

	return seen.configs
}

describe('a delegation can narrow the child it spawns', () => {
	it('reaches a child whose builder returns a fixed config', async () => {
		// Criterion 2, and the reason the stamp is placed where it is: this
		// builder ignores everything it is handed, so a scope applied before
		// it would be discarded without a trace.
		const [config] = await spawn({ spawns: [{ deny: ['bash'] }] })

		expect(config?.deniedTools).toEqual(['bash'])
	})

	it('reaches a child registered without a builder at all', async () => {
		// The manager builds a config on two branches, and this one is easy to
		// forget because it is the branch nothing in this repo takes. Written
		// inside the builder arm the stamp read correctly and left a caller
		// here holding a scope that did nothing — a narrower child requested
		// and a wider one delivered.
		const [config] = await spawn({ withBuilder: false, spawns: [{ deny: ['bash'] }] })

		expect(config?.deniedTools).toEqual(['bash'])
	})

	it('adds to what the builder already denied rather than replacing it', async () => {
		// A definition that denies a tool is stating something about the agent
		// itself. A delegation is stating something about one task. Neither
		// outranks the other and both are restrictions, so they compose.
		const [config] = await spawn({
			builderDenies: ['rm'],
			spawns: [{ deny: ['bash'] }],
		})

		expect(config?.deniedTools).toEqual(['rm', 'bash'])
	})

	it('replaces the persona for that delegation only', async () => {
		// Criterion 4. Two spawns of the same registered agent: the first
		// overrides, the second does not. The second getting the definition's
		// persona back is the actual claim — an override written onto shared
		// state would pass a single-spawn test and leak into every later one.
		const configs = await spawn({
			builderPersona: PERSONA('generalist'),
			spawns: [{ personaOverride: PERSONA('auditor') }, {}],
		})

		expect(configs[0]?.persona?.identity.role).toBe('auditor')
		expect(configs[1]?.persona?.identity.role).toBe('generalist')
	})

	it('leaves a delegation that scopes nothing exactly as it was', async () => {
		// Absent must stay absent rather than becoming an empty array every
		// reader then has to tell apart from a real one.
		const [config] = await spawn({ spawns: [{}] })

		expect(config?.deniedTools).toBeUndefined()
		expect(config?.persona).toBeUndefined()
	})
})
