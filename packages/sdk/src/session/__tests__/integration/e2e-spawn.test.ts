/**
 * End-to-end SubSession spawn flow.
 *
 * Builds Tenant → Project → Session → simulated Run → spawnSubAgent →
 * SubSession → child Run → child completion → SessionSummaryRef materialized
 * → parent reads the child summary via `sessionStore.drill`. Asserts the
 * event sequence matches §10.5 of session-hierarchy.md (spawn, child run,
 * idled).
 *
 * Covers Phase 6 invariants #1–5 in the pattern doc checklist:
 *  - Sub-session spawn triple (SubSession + Session + workspace meta)
 *  - Kernel-materialized Summary on completion
 *  - Lineage on every sub-session event (depth, rootSessionId)
 *  - Atomic `recordSummary` flip active→idle
 *  - `sessionStore.drill` surfaces the child's structure after completion
 */

import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentManager } from '../../../manager/agent/lifecycle.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import type {
	AgentCapabilities,
	AgentInput,
	BaseAgentConfig,
	BaseAgentResult,
} from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { RunId, TenantId, UserId } from '../../../types/ids/index.js'
import { createAssistantMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import type { SummaryId, ThreadId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import type { ActorRef } from '../../hierarchy/actor.js'
import { SessionSummaryMaterializer } from '../../summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'

const TEST_THREAD_ID = 'thd_test' as ThreadId

const tenant = 'tnt_alpha' as TenantId

const capabilities: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}

function buildAgent(id: string): Agent<BaseAgentConfig, BaseAgentResult> {
	return {
		type: 'reactive',
		metadata: {
			type: 'reactive',
			id,
			name: id,
			version: '1.0.0',
			category: 'test',
			description: id,
			capabilities,
		},
		run: async (_input: AgentInput, _config: BaseAgentConfig): Promise<BaseAgentResult> => ({
			runId: 'run_child' as RunId,
			status: 'completed',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 1,
			durationMs: 1,
			messages: [createAssistantMessage('child did the work')],
			result: 'child did the work',
		}),
		cancel: async () => undefined,
		getCapabilities: () => capabilities,
	}
}

function buildDefinition(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
	return {
		info: {
			id: agent.metadata.id,
			name: agent.metadata.name,
			version: agent.metadata.version,
			category: agent.metadata.category,
			description: agent.metadata.description,
			tools: [],
			defaults: { model: 'test', tokenBudget: 1_000 },
		},
		typedAgent: agent,
	}
}

describe('E2E — SubSession spawn → kernel summary → parent drill', () => {
	it('emits the §10.5 event sequence with lineage + schemaVersion stamping', async () => {
		const store = new InMemorySessionStore()
		const project = await store.createProject({ tenantId: tenant, name: 'e2e-project' }, tenant)

		const userActor: ActorRef = {
			kind: 'user',
			userId: 'usr_root' as UserId,
			tenantId: tenant,
		}

		const parentSession = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor },
			tenant,
		)
		// Parent Run in flight — session active while the spawn is happening.
		await store.updateSession({ ...parentSession, status: 'active' }, tenant)

		let summaryCounter = 0
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => `sum_test_${++summaryCounter}` as SummaryId,
		})

		const registry = new AgentRegistry()
		registry.register(buildDefinition(buildAgent('worker')))

		const manager = new AgentManager(registry, undefined, {
			sessionStore: store,
			summaryMaterializer: materializer,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
		})

		const capturedEvents: RunEvent[] = []
		const listener = (event: RunEvent): void => {
			capturedEvents.push(event)
		}

		const taskContext: AgentTaskContext = {
			parentRunId: 'run_parent' as RunId,
			parentAgentId: 'supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budgetTracker: { total: 100_000, remaining: 100_000 },
			tenantId: tenant,
			sessionId: parentSession.id,
			projectId: project.id,
			parentActor: userActor,
		}

		const options: SendMessageOptions = {
			agentId: 'worker',
			input: { messages: [], workingDirectory: '/tmp' },
			parentSessionId: parentSession.id,
			tenantId: tenant,
			projectId: project.id,
			parentActor: userActor,
		}

		const task = await manager.sendMessage(options, taskContext, listener)
		await manager.waitForCompletion(task.taskId)

		// --- Event sequence assertions ---
		const eventTypes = capturedEvents.map((e) => e.type)
		expect(eventTypes).toEqual([
			'agent_pending',
			'subsession_spawned',
			'subsession_idled',
			'agent_completed',
		])

		const spawned = capturedEvents.find((e) => e.type === 'subsession_spawned')
		const idled = capturedEvents.find((e) => e.type === 'subsession_idled')
		expect(spawned).toBeDefined()
		expect(idled).toBeDefined()

		// --- Lineage + schemaVersion invariants ---
		if (spawned && 'lineage' in spawned && 'schemaVersion' in spawned) {
			expect(spawned.lineage.parentSessionId).toBe(parentSession.id)
			expect(spawned.lineage.rootSessionId).toBe(parentSession.id)
			expect(spawned.lineage.depth).toBe(1)
			expect(spawned.schemaVersion).toBe(2)
		}
		if (idled && 'lineage' in idled && 'schemaVersion' in idled) {
			expect(idled.lineage.rootSessionId).toBe(parentSession.id)
			expect(idled.lineage.depth).toBe(1)
			expect(idled.schemaVersion).toBe(2)
		}

		// --- Summary materialized by kernel ---
		const spawnRecord = manager.getSpawnRecord(task.taskId)
		expect(spawnRecord).toBeDefined()
		const summary = await store.getSummary(spawnRecord!.childSessionId, tenant)
		expect(summary).toBeDefined()
		expect(summary?.materializedBy).toBe('kernel')
		expect(summary?.agentSummary).toBe('child did the work')
		expect(summary?.outcome.status).toBe('succeeded')

		// --- SubSession transitioned to idle with summaryRef attached ---
		const subSession = await store.getSubSession(spawnRecord!.subSessionId, tenant)
		expect(subSession?.status).toBe('idle')
		expect(subSession?.summaryRef).toBe(summary?.id)

		// --- Child session status flipped atomically with summary ---
		const childSession = await store.getSession(spawnRecord!.childSessionId, tenant)
		expect(childSession?.status).toBe('idle')

		// --- Parent drills into the child; rootSessionId identical across tree ---
		const parentDrill = await store.drill(parentSession.id, tenant)
		expect(parentDrill).not.toBeNull()
		expect(parentDrill?.children.length).toBe(1)
		expect(parentDrill?.children[0]?.childSessionId).toBe(spawnRecord!.childSessionId)

		const childDrill = await store.drill(spawnRecord!.childSessionId, tenant)
		expect(childDrill).not.toBeNull()
		expect(childDrill?.ancestry[0]).toBe(parentSession.id)
		expect(childDrill?.ancestry[childDrill.ancestry.length - 1]).toBe(spawnRecord!.childSessionId)
	})

	it('closes the parent→child message gap: parent can re-ingest child content via drill + summary', async () => {
		const store = new InMemorySessionStore()
		const project = await store.createProject({ tenantId: tenant, name: 'e2e-gap' }, tenant)

		const userActor: ActorRef = {
			kind: 'user',
			userId: 'usr_root' as UserId,
			tenantId: tenant,
		}
		const parentSession = await store.createSession(
			{ threadId: TEST_THREAD_ID, projectId: project.id, currentActor: userActor },
			tenant,
		)
		await store.updateSession({ ...parentSession, status: 'active' }, tenant)

		let counter = 0
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => `sum_gap_${++counter}` as SummaryId,
		})

		const registry = new AgentRegistry()
		registry.register(buildDefinition(buildAgent('worker')))

		const manager = new AgentManager(registry, undefined, {
			sessionStore: store,
			summaryMaterializer: materializer,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
		})

		const task = await manager.sendMessage(
			{
				agentId: 'worker',
				input: { messages: [], workingDirectory: '/tmp' },
				parentSessionId: parentSession.id,
				tenantId: tenant,
				projectId: project.id,
				parentActor: userActor,
			},
			{
				parentRunId: 'run_parent' as RunId,
				parentAgentId: 'supervisor',
				parentAbortController: new AbortController(),
				depth: 0,
				budgetTracker: { total: 10_000, remaining: 10_000 },
				tenantId: tenant,
				sessionId: parentSession.id,
				projectId: project.id,
				parentActor: userActor,
			},
		)
		await manager.waitForCompletion(task.taskId)

		const spawnRecord = manager.getSpawnRecord(task.taskId)
		expect(spawnRecord).toBeDefined()

		// Close the gap: parent references the child's summary via store.drill —
		// no loose-cast Object.assign, no transcript re-inlining, just a typed
		// structural pointer.
		const view = await store.drill(spawnRecord!.childSessionId, tenant)
		expect(view?.session.id).toBe(spawnRecord!.childSessionId)
		const summary = await store.getSummary(spawnRecord!.childSessionId, tenant)
		expect(summary?.sessionRef).toBe(spawnRecord!.childSessionId)
	})
})
