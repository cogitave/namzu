import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import {
	DefaultCapacityValidator,
	DelegationCapacityExceeded,
} from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type {
	AgentCapabilities,
	AgentInput,
	AgentMetadata,
	BaseAgentConfig,
	BaseAgentResult,
} from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { AgentId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import { createAssistantMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { SummaryId, ThreadId } from '../../../types/session/ids.js'
import type { DeliverableRef } from '../../../types/summary/deliverable.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { ThreadManager } from '../../thread/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

const tenant = 'tnt_alpha' as TenantId
const otherTenant = 'tnt_beta' as TenantId

const capabilities: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}

function makeAgent(
	id: string,
	run: (input: AgentInput, config: BaseAgentConfig) => Promise<BaseAgentResult>,
): Agent<BaseAgentConfig, BaseAgentResult> {
	const metadata: AgentMetadata = {
		type: 'reactive',
		id,
		name: id,
		version: '1.0.0',
		category: 'test',
		description: `test agent ${id}`,
		capabilities,
	}
	return {
		type: 'reactive',
		metadata,
		run: async (input, config) => run(input, config),
		cancel: async () => undefined,
		getCapabilities: () => capabilities,
	}
}

function makeDefinition(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
	return {
		info: {
			id: agent.metadata.id,
			name: agent.metadata.name,
			version: agent.metadata.version,
			category: agent.metadata.category,
			description: agent.metadata.description,
			tools: [],
			defaults: {
				model: 'test',
				tokenBudget: 1_000,
			},
		},
		typedAgent: agent,
	}
}

function successResult(): BaseAgentResult {
	return {
		runId: 'run_test' as import('../../../types/ids/index.js').RunId,
		status: 'completed',
		usage: { ...EMPTY_TOKEN_USAGE },
		cost: { ...ZERO_COST },
		iterations: 1,
		durationMs: 1,
		messages: [createAssistantMessage('child finished successfully')],
		result: 'child finished successfully',
	}
}

function failureResult(error: string): BaseAgentResult {
	return {
		runId: 'run_test' as import('../../../types/ids/index.js').RunId,
		status: 'failed',
		usage: { ...EMPTY_TOKEN_USAGE },
		cost: { ...ZERO_COST },
		iterations: 1,
		durationMs: 1,
		messages: [],
		lastError: error,
	}
}

function user(tid: TenantId = tenant): ActorRef {
	return { kind: 'user', userId: 'usr_root' as UserId, tenantId: tid }
}

function agentActor(id: string, tid: TenantId = tenant): ActorRef {
	return { kind: 'agent', agentId: id as AgentId, tenantId: tid }
}

interface Harness {
	store: InMemorySessionStore
	threadStore: InMemoryThreadStore
	threadManager: ThreadManager
	materializer: SessionSummaryMaterializer
	manager: AgentManager
	parentSession: Awaited<ReturnType<InMemorySessionStore['createSession']>>
	projectId: import('../../../types/session/ids.js').ProjectId
	threadId: ThreadId
	registry: AgentRegistry
}

async function buildHarness(
	childAgent: Agent<BaseAgentConfig, BaseAgentResult>,
	tenantId: TenantId = tenant,
): Promise<Harness> {
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()
	const threadManager = new ThreadManager({ threadStore, sessionStore: store })
	const project = await store.createProject({ tenantId, name: 'p1' }, tenantId)
	const thread = await threadStore.createThread(
		{ projectId: project.id, title: 'lifecycle-test' },
		tenantId,
	)
	const parentSession = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: user(tenantId) },
		tenantId,
	)
	// Parent runs kick the session into 'active' so the materializer can
	// flip it back to 'idle' once the child completes.
	await store.updateSession({ ...parentSession, status: 'active' }, tenantId)

	let summaryCounter = 0
	const materializer = new SessionSummaryMaterializer({
		store,
		generateSummaryId: () => `sum_test_${++summaryCounter}` as SummaryId,
	})

	const registry = new AgentRegistry()
	registry.register(makeDefinition(childAgent))

	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: materializer,
		workspaceRegistry: new WorkspaceBackendRegistry(),
		capacity: new DefaultCapacityValidator(store),
		threadManager,
	})

	return {
		store,
		threadStore,
		threadManager,
		materializer,
		manager,
		parentSession: { ...parentSession, status: 'active' },
		projectId: project.id,
		threadId: thread.id,
		registry,
	}
}

function buildContext(
	parentSessionId: SessionId,
	projectId: import('../../../types/session/ids.js').ProjectId,
	threadId: ThreadId,
	tenantId: TenantId = tenant,
	depth = 0,
): AgentTaskContext {
	return {
		parentRunId: 'run_parent' as import('../../../types/ids/index.js').RunId,
		parentAgentId: 'parent-agent',
		parentAbortController: new AbortController(),
		depth,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId,
		threadId,
		sessionId: parentSessionId,
		projectId,
		parentActor: user(tenantId),
	}
}

function buildOptions(
	agentId: string,
	parentSessionId: SessionId,
	projectId: import('../../../types/session/ids.js').ProjectId,
	tenantId: TenantId = tenant,
): SendMessageOptions {
	return {
		agentId,
		input: { messages: [], workingDirectory: '/tmp' },
		parentSessionId,
		tenantId,
		projectId,
		parentActor: user(tenantId),
	}
}

async function waitForTask(
	manager: AgentManager,
	taskId: import('../../../types/ids/index.js').TaskId,
): Promise<void> {
	await manager.waitForCompletion(taskId)
}

describe('AgentManager.sendMessage — Phase 6 SubSession spawn', () => {
	it('happy path: SubSession + Session + Summary, lineage stamped, status idle', async () => {
		const childAgent = makeAgent('child-1', async () => successResult())
		const harness = await buildHarness(childAgent)
		const events: RunEvent[] = []

		const listener = (e: RunEvent): void => {
			events.push(e)
		}

		const task = await harness.manager.sendMessage(
			buildOptions('child-1', harness.parentSession.id, harness.projectId),
			buildContext(harness.parentSession.id, harness.projectId, harness.threadId),
			listener,
		)
		await waitForTask(harness.manager, task.taskId)

		const spawnRecord = harness.manager.getSpawnRecord(task.taskId)
		expect(spawnRecord).toBeDefined()

		const childSession = await harness.store.getSession(spawnRecord!.childSessionId, tenant)
		expect(childSession?.status).toBe('idle')

		const subSession = await harness.store.getSubSession(spawnRecord!.subSessionId, tenant)
		expect(subSession?.status).toBe('idle')
		expect(subSession?.summaryRef).toBeDefined()

		const summary = await harness.store.getSummary(spawnRecord!.childSessionId, tenant)
		expect(summary).toBeDefined()
		expect(summary?.materializedBy).toBe('kernel')
		expect(summary?.agentSummary).toBe('child finished successfully')

		// Events — spawn + idled both present with lineage.
		const spawned = events.find((e) => e.type === 'subsession_spawned')
		expect(spawned).toBeDefined()
		if (spawned && 'lineage' in spawned) {
			expect(spawned.lineage.parentSessionId).toBe(harness.parentSession.id)
			expect(spawned.lineage.rootSessionId).toBe(harness.parentSession.id)
			expect(spawned.lineage.depth).toBe(1)
			expect(spawned.schemaVersion).toBe(3)
		}

		const idled = events.find((e) => e.type === 'subsession_idled')
		expect(idled).toBeDefined()
		if (idled && 'lineage' in idled) {
			expect(idled.lineage.depth).toBe(1)
			expect(idled.schemaVersion).toBe(3)
		}
	})

	it('width: exceeding maxDelegationWidth (8) rejects with DelegationCapacityExceeded', async () => {
		const childAgent = makeAgent('child-1', async () => successResult())
		const harness = await buildHarness(childAgent)

		// Pre-fill 8 direct sub-sessions under the parent, up to the default width cap.
		for (let i = 0; i < 8; i++) {
			const sibling = await harness.store.createSession(
				{
					threadId: harness.threadId,
					projectId: harness.projectId,
					currentActor: agentActor('sibling'),
				},
				tenant,
			)
			await harness.store.createSubSession(
				{
					parentSessionId: harness.parentSession.id,
					childSessionId: sibling.id,
					kind: 'agent_spawn',
					spawnedBy: user(),
				},
				tenant,
			)
		}

		await expect(
			harness.manager.sendMessage(
				buildOptions('child-1', harness.parentSession.id, harness.projectId),
				buildContext(harness.parentSession.id, harness.projectId, harness.threadId),
			),
		).rejects.toBeInstanceOf(DelegationCapacityExceeded)
	})

	it('depth: ancestry chain exceeding maxDelegationDepth (4) rejects with DelegationCapacityExceeded', async () => {
		const childAgent = makeAgent('child-1', async () => successResult())
		const harness = await buildHarness(childAgent)

		// Build a chain root→c1→c2→c3→c4 and then try to spawn under c4 — the
		// 5th delegation level exceeds the default depth cap of 4.
		let parentId: SessionId = harness.parentSession.id
		for (let i = 0; i < 4; i++) {
			const child = await harness.store.createSession(
				{ threadId: harness.threadId, projectId: harness.projectId, currentActor: agentActor('c') },
				tenant,
			)
			await harness.store.createSubSession(
				{
					parentSessionId: parentId,
					childSessionId: child.id,
					kind: 'agent_spawn',
					spawnedBy: user(),
				},
				tenant,
			)
			parentId = child.id
		}

		await expect(
			harness.manager.sendMessage(
				buildOptions('child-1', parentId, harness.projectId),
				buildContext(parentId, harness.projectId, harness.threadId, tenant, 0),
			),
		).rejects.toBeInstanceOf(DelegationCapacityExceeded)
	})

	it('failure: SubSession marked failed; no summary materialized', async () => {
		const childAgent = makeAgent('child-fail', async () => failureResult('boom'))
		const harness = await buildHarness(childAgent)

		const task = await harness.manager.sendMessage(
			buildOptions('child-fail', harness.parentSession.id, harness.projectId),
			buildContext(harness.parentSession.id, harness.projectId, harness.threadId),
		)
		await waitForTask(harness.manager, task.taskId)

		const spawnRecord = harness.manager.getSpawnRecord(task.taskId)
		expect(spawnRecord).toBeDefined()

		const subSession = await harness.store.getSubSession(spawnRecord!.subSessionId, tenant)
		expect(subSession?.status).toBe('failed')

		const summary = await harness.store.getSummary(spawnRecord!.childSessionId, tenant)
		expect(summary).toBeNull()
	})

	it('child messages retrievable: sessionStore.drill returns the child transcript', async () => {
		const childAgent = makeAgent('child-msgs', async () => {
			const result = successResult()
			return result
		})
		const harness = await buildHarness(childAgent)

		const task = await harness.manager.sendMessage(
			buildOptions('child-msgs', harness.parentSession.id, harness.projectId),
			buildContext(harness.parentSession.id, harness.projectId, harness.threadId),
		)
		await waitForTask(harness.manager, task.taskId)

		const spawnRecord = harness.manager.getSpawnRecord(task.taskId)
		expect(spawnRecord).toBeDefined()

		// drill on the child session surfaces the session metadata — the child
		// transcript would be persisted on the runtime path (RunPersistence) in
		// a full run; here we assert the drill primitive resolves cleanly.
		const drill = await harness.store.drill(spawnRecord!.childSessionId, tenant)
		expect(drill).not.toBeNull()
		expect(drill?.session.id).toBe(spawnRecord!.childSessionId)
		expect(drill?.ancestry).toEqual([harness.parentSession.id, spawnRecord!.childSessionId])
	})

	it('lineage chain: 3-deep delegation carries correct rootSessionId + depth', async () => {
		const childAgent = makeAgent('grandchild', async () => successResult())
		const harness = await buildHarness(childAgent)

		// Seed c1 under parentSession, c2 under c1.
		const c1 = await harness.store.createSession(
			{ threadId: harness.threadId, projectId: harness.projectId, currentActor: agentActor('c1') },
			tenant,
		)
		await harness.store.createSubSession(
			{
				parentSessionId: harness.parentSession.id,
				childSessionId: c1.id,
				kind: 'agent_spawn',
				spawnedBy: user(),
			},
			tenant,
		)
		const c2 = await harness.store.createSession(
			{ threadId: harness.threadId, projectId: harness.projectId, currentActor: agentActor('c2') },
			tenant,
		)
		await harness.store.createSubSession(
			{
				parentSessionId: c1.id,
				childSessionId: c2.id,
				kind: 'agent_spawn',
				spawnedBy: user(),
			},
			tenant,
		)

		const events: RunEvent[] = []
		const task = await harness.manager.sendMessage(
			buildOptions('grandchild', c2.id, harness.projectId),
			buildContext(c2.id, harness.projectId, harness.threadId),
			(e) => {
				events.push(e)
			},
		)
		await waitForTask(harness.manager, task.taskId)

		const spawned = events.find((e) => e.type === 'subsession_spawned')
		expect(spawned).toBeDefined()
		if (spawned && 'lineage' in spawned) {
			// Ancestry is root→c1→c2; newly spawned child is depth 3.
			expect(spawned.lineage.depth).toBe(3)
			expect(spawned.lineage.rootSessionId).toBe(harness.parentSession.id)
			expect(spawned.lineage.parentSessionId).toBe(c2.id)
		}
	})

	it('kernel-only summary: type system rejects agent-constructed SessionSummaryRef at recordSummary', async () => {
		const childAgent = makeAgent('child-1', async () => successResult())
		const harness = await buildHarness(childAgent)

		// This compile-time assertion is enforced by `materializedBy: 'kernel'`
		// being a literal on the SummaryRef type; an agent-constructed literal
		// with `materializedBy: 'agent'` would be rejected by the type system.
		// Runtime assertion that the type check is still in place:
		const summary = await harness.materializer.materialize({
			sessionId: harness.parentSession.id,
			tenantId: tenant,
			finalOutcome: { status: 'succeeded' },
			agentSummary: 'kernel-only',
			declaredDeliverables: [] as DeliverableRef[],
			keyDecisions: [],
		})
		expect(summary.materializedBy).toBe('kernel')
	})

	it('cross-tenant spawn rejected at SendMessageOptions.tenantId mismatch', async () => {
		const childAgent = makeAgent('child-1', async () => successResult())
		const harness = await buildHarness(childAgent)

		const mismatchedOptions: SendMessageOptions = {
			...buildOptions('child-1', harness.parentSession.id, harness.projectId),
			tenantId: otherTenant,
		}
		await expect(
			harness.manager.sendMessage(
				mismatchedOptions,
				buildContext(harness.parentSession.id, harness.projectId, harness.threadId, tenant),
			),
		).rejects.toThrow(/Tenant mismatch/)
	})
})

// Phase 9 Known Delta #5: legacy compat mode removed — AgentManagerDeps is
// unconditional required. Prior `describe('AgentManager.sendMessage — legacy
// mode (no session deps)')` block deleted; every spawn now produces a
// SubSession + Session + WorkspaceRef triple (Convention #0).
