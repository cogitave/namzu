import { describe, expect, it } from 'vitest'

import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { fixtureId, fixtureUuid } from '../../../test-support/ids.js'
import { createFileReadTracker } from '../../../tools/file-read-tracker.js'
import type { BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { AgentId, TenantId } from '../../../types/ids/index.js'
import type { SummaryId } from '../../../types/session/ids.js'
import type { FileReadTracker } from '../../../types/tool/index.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A delegated child is a fresh turn with its own executor, and so, unless it is
 * handed one, a file ledger that begins when the child does. A script its
 * parent wrote or made through the shell then looks older than the child's
 * session, and the auto-mode classifier does not read it when the child runs
 * it. The delegation tools hand the parent's ledger over through
 * `configOverrides.fileReadTracker`; the manager must put it on the child's
 * config whichever way the child's config is built.
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
				sessionId: fixtureId.session('child'),
				turnId: fixtureId.turn('child'),
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
	readonly override?: FileReadTracker
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
		parentSessionId: 'c0250b29-330b-445f-b11d-2926ffd9059c' as never,
		parentTurnId: '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e' as never,
		parentAgentId: 'sup',
		parentAbortController: new AbortController(),
		depth: 0,
		budget: SessionTokenBudget.create(100_000, {
			rootSessionId: generateSessionId(),
			rootTurnId: generateTurnId(),
		}),
		tenantId: TENANT,
		topicId: thread.id,
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
			...(options.override ? { configOverrides: { fileReadTracker: options.override } } : {}),
		} as never,
		context,
	)

	await manager.waitForCompletion(task.taskId)
	return seen.config
}

/** The child has its own reader record over the parent's authored ledger. */
function expectSharesWhatWasAuthored(
	child: FileReadTracker | undefined,
	parent: FileReadTracker,
): void {
	expect(child).toBeDefined()
	expect(child).not.toBe(parent)
	expect(child?.startedAt).toBe(parent.startedAt)
	parent.recordRead('/w/script.sh', 'echo hi\n', 'call-1')
	expect(child?.authoredFingerprint?.('/w/script.sh')).toBe(
		parent.authoredFingerprint?.('/w/script.sh'),
	)
	expect(child?.authoredFingerprint?.('/w/script.sh')).toBeDefined()
	expect(child?.hasRead('/w/script.sh')).toBe(false)
}

describe('the file ledger of the turn that delegated', () => {
	it('reaches a child whose configBuilder never heard of it', async () => {
		const parent = createFileReadTracker()
		const config = await spawnWith({ override: parent })
		expectSharesWhatWasAuthored(config?.fileReadTracker, parent)
	})

	it('reaches a child built on the manager\u2019s other branch too', async () => {
		const parent = createFileReadTracker()
		const config = await spawnWith({ override: parent, withBuilder: false })
		expectSharesWhatWasAuthored(config?.fileReadTracker, parent)
	})

	it('is absent when the spawn did not carry one', async () => {
		const config = await spawnWith({})
		expect(config?.fileReadTracker).toBeUndefined()
	})
})
