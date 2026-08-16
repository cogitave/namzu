import { describe, expect, it } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { AgentId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * `continueTask` accepted a message and nothing ever delivered it.
 *
 * It pushed onto `agentTask.pendingMessages`, and nothing in the kernel
 * called `drainMessages` outside its own definition — the manager
 * interface's own docblock said "the runtime does not deliver it", and
 * `continue_task` was unmounted from the coordinator tools for exactly this
 * reason. So a supervisor could redirect a running worker through a public
 * API and have the instruction silently go nowhere.
 *
 * The delivery point is stamped on the child's config after the
 * `configBuilder` returns, for the same reason `parentSpan`, `resumeHandler`
 * and `env` are: a builder written by whoever registered the agent cannot
 * forward a field it was never told about.
 */

const TENANT = 'tnt_queue' as TenantId

function recordingAgent(
	seen: { configs: BaseAgentConfig[]; running?: () => void },
	hold?: Promise<void>,
) {
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
			// Held so a test can queue a message while the child is RUNNING,
			// which is the only moment `continueTask` is meant for — after it
			// settles the queue is refused, and that refusal is its own test.
			seen.running?.()
			if (hold) await hold
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

/** A definition WITH a builder that returns a fixed config and ignores everything. */
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

async function harness(opts: { hold?: boolean } = {}) {
	let release: () => void = () => {}
	const held = opts.hold
		? new Promise<void>((resolve) => {
				release = resolve
			})
		: undefined
	let started: () => void = () => {}
	const running = new Promise<void>((resolve) => {
		started = resolve
	})
	const seen = { configs: [] as BaseAgentConfig[], running: () => started() }
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
	registry.register(definition(recordingAgent(seen, held)))

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

	const task = await manager.sendMessage(
		{
			agentId: 'worker',
			input: { messages: [], workingDirectory: '/tmp' } as never,
			parentSessionId: parentSession.id,
			tenantId: TENANT,
			projectId: project.id,
			parentActor,
		} as never,
		context,
	)

	return { manager, task, seen, release, running }
}

describe('a message queued for a child reaches it', () => {
	it('stamps a drain the child can call, through a builder that ignores the field', async () => {
		// The builder returns a fixed config, which is what most real ones do
		// — so a stamp applied BEFORE it would be discarded without a trace.
		const { manager, task, seen } = await harness()
		await manager.waitForCompletion(task.taskId)

		expect(typeof seen.configs[0]?.inboundMessages).toBe('function')
	})

	it('hands the child exactly what was queued, once', async () => {
		// Queued while the child is RUNNING, which is the only moment
		// `continueTask` is for.
		const { manager, task, seen, release, running } = await harness({ hold: true })
		await running
		const drain = seen.configs[0]?.inboundMessages
		expect(drain).toBeDefined()
		if (!drain) {
			release()
			return
		}

		manager.queueMessage(task.taskId, createUserMessage('switch to Y'))

		expect(drain().map((m) => m.content)).toEqual(['switch to Y'])
		// Drained, not read. A peek would re-deliver on every boundary for
		// the rest of the run.
		expect(drain()).toEqual([])
		release()
		await manager.waitForCompletion(task.taskId)
	})

	it('refuses a message queued for a task that has settled', async () => {
		// A silent push leaves the caller believing something is in flight
		// when the only thing that would ever have drained it has finished.
		const { manager, task } = await harness()
		await manager.waitForCompletion(task.taskId)

		expect(() => manager.queueMessage(task.taskId, createUserMessage('too late'))).toThrow(
			/terminal task/,
		)
		// And nothing was retained on the dead task, so there is no state in
		// which a caller believes a message is in flight when nothing is.
		expect(manager.drainMessages(task.taskId)).toEqual([])
	})
})
