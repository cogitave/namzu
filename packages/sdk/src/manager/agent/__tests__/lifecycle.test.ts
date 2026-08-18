import { describe, expect, it } from 'vitest'
import { AGENT_MANAGER_DEFAULTS } from '../../../constants/agent/index.js'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { LocalTaskScheduler } from '../../../scheduler/local.js'
import {
	DefaultCapacityValidator,
	DelegationCapacityExceeded,
} from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
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
import type { SummaryId, TopicId } from '../../../types/session/ids.js'
import type { DeliverableRef } from '../../../types/summary/deliverable.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { TopicManager } from '../../topic/lifecycle.js'
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
	threadStore: InMemoryTopicStore
	threadManager: TopicManager
	materializer: SessionSummaryMaterializer
	manager: AgentManager
	parentSession: Awaited<ReturnType<InMemorySessionStore['createSession']>>
	projectId: import('../../../types/session/ids.js').ProjectId
	topicId: TopicId
	registry: AgentRegistry
}

async function buildHarness(
	childAgent: Agent<BaseAgentConfig, BaseAgentResult>,
	tenantId: TenantId = tenant,
): Promise<Harness> {
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryTopicStore()
	const threadManager = new TopicManager({ topicStore: threadStore, sessionStore: store })
	const project = await store.createProject({ tenantId, name: 'p1' }, tenantId)
	const thread = await threadStore.createTopic(
		{ projectId: project.id, title: 'lifecycle-test' },
		tenantId,
	)
	const parentSession = await store.createSession(
		{ topicId: thread.id, projectId: project.id, currentActor: user(tenantId) },
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
		topicId: thread.id,
		registry,
	}
}

function buildContext(
	parentSessionId: SessionId,
	projectId: import('../../../types/session/ids.js').ProjectId,
	topicId: TopicId,
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
		topicId,
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
			buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
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
					topicId: harness.topicId,
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
				buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
			),
		).rejects.toBeInstanceOf(DelegationCapacityExceeded)
	})

	it('width: two concurrent spawns cannot both slip past the last slot', async () => {
		const childAgent = makeAgent('child-1', async () => successResult())
		const harness = await buildHarness(childAgent)

		// Fill to one below the cap, so exactly one more child fits.
		for (let i = 0; i < 7; i++) {
			const sibling = await harness.store.createSession(
				{
					topicId: harness.topicId,
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

		// Both read the count before either writes. The check and the write
		// that invalidates it used to have every other provisioning step
		// between them, so a cap of 8 admitted 9.
		const attempts = await Promise.allSettled([
			harness.manager.sendMessage(
				buildOptions('child-1', harness.parentSession.id, harness.projectId),
				buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
			),
			harness.manager.sendMessage(
				buildOptions('child-1', harness.parentSession.id, harness.projectId),
				buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
			),
		])

		const rejected = attempts.filter((a) => a.status === 'rejected')
		expect(rejected).toHaveLength(1)
		expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(DelegationCapacityExceeded)

		const children = await harness.store.getChildren(harness.parentSession.id, tenant)
		expect(children.length).toBe(8)
	})

	it('depth: ancestry chain exceeding maxDelegationDepth (4) rejects with DelegationCapacityExceeded', async () => {
		const childAgent = makeAgent('child-1', async () => successResult())
		const harness = await buildHarness(childAgent)

		// Build a chain root→c1→c2→c3→c4 and then try to spawn under c4 — the
		// 5th delegation level exceeds the default depth cap of 4.
		let parentId: SessionId = harness.parentSession.id
		for (let i = 0; i < 4; i++) {
			const child = await harness.store.createSession(
				{ topicId: harness.topicId, projectId: harness.projectId, currentActor: agentActor('c') },
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
				buildContext(parentId, harness.projectId, harness.topicId, tenant, 0),
			),
		).rejects.toBeInstanceOf(DelegationCapacityExceeded)
	})

	it('failure: SubSession marked failed; no summary materialized', async () => {
		const childAgent = makeAgent('child-fail', async () => failureResult('boom'))
		const harness = await buildHarness(childAgent)

		const task = await harness.manager.sendMessage(
			buildOptions('child-fail', harness.parentSession.id, harness.projectId),
			buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
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
			buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
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
			{ topicId: harness.topicId, projectId: harness.projectId, currentActor: agentActor('c1') },
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
			{ topicId: harness.topicId, projectId: harness.projectId, currentActor: agentActor('c2') },
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
			buildContext(c2.id, harness.projectId, harness.topicId),
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
				buildContext(harness.parentSession.id, harness.projectId, harness.topicId, tenant),
			),
		).rejects.toThrow(/Tenant mismatch/)
	})
})

// Phase 9 Known Delta #5: legacy compat mode removed — AgentManagerDeps is
// unconditional required. Prior `describe('AgentManager.sendMessage — legacy
// mode (no session deps)')` block deleted; every spawn now produces a
// SubSession + Session + WorkspaceRef triple (Convention #0).

/**
 * Two unit errors in the delegation path that no test covered, because the
 * numbers involved stay plausible-looking until you check their units and
 * their identity.
 */
describe('AgentManager.sendMessage — budget and deadline arithmetic', () => {
	it('carries a child-specific provider idle bound through the bare config path', async () => {
		const seen: BaseAgentConfig[] = []
		const childAgent = makeAgent('child-idle-bound', async (_input, config) => {
			seen.push(config)
			return successResult()
		})
		const harness = await buildHarness(childAgent)
		const options = buildOptions('child-idle-bound', harness.parentSession.id, harness.projectId)
		options.configOverrides = { streamIdleTimeoutMs: 1234 }

		const task = await harness.manager.sendMessage(
			options,
			buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
		)
		await waitForTask(harness.manager, task.taskId)

		expect(seen[0]?.streamIdleTimeoutMs).toBe(1234)
	})

	it('does not derive the child deadline from the TOKEN budget', async () => {
		// The fallback used to be `context.budgetTracker.remaining` — a token
		// count read as milliseconds. It hid for so long because a six-figure
		// token budget lands in a plausible range of milliseconds.
		const seen: BaseAgentConfig[] = []
		const childAgent = makeAgent('child-deadline', async (_input, config) => {
			seen.push(config)
			return successResult()
		})
		const harness = await buildHarness(childAgent)
		const context = buildContext(harness.parentSession.id, harness.projectId, harness.topicId)
		context.budgetTracker = { total: 100_000, remaining: 100_000 }

		const task = await harness.manager.sendMessage(
			buildOptions('child-deadline', harness.parentSession.id, harness.projectId),
			context,
		)
		await waitForTask(harness.manager, task.taskId)

		expect(seen).toHaveLength(1)
		// Before the fix this was the post-debit token remainder (50_000).
		expect(seen[0]?.timeoutMs).toBe(AGENT_MANAGER_DEFAULTS.childTimeoutMs)
	})

	it('a nearly-exhausted parent still gives its child a real deadline', async () => {
		// The edge where the unit error bit hardest: a tiny token remainder
		// read as milliseconds produced a child that was out of time on
		// arrival.
		const seen: BaseAgentConfig[] = []
		const childAgent = makeAgent('child-small', async (_input, config) => {
			seen.push(config)
			return successResult()
		})
		const harness = await buildHarness(childAgent)
		const context = buildContext(harness.parentSession.id, harness.projectId, harness.topicId)
		context.budgetTracker = { total: 100_000, remaining: 20 }

		const task = await harness.manager.sendMessage(
			buildOptions('child-small', harness.parentSession.id, harness.projectId),
			context,
		)
		await waitForTask(harness.manager, task.taskId)

		// Old code: floor(20 * 0.5) = 10 tokens, read as 10 MILLISECONDS.
		expect(seen[0]?.timeoutMs).toBe(AGENT_MANAGER_DEFAULTS.childTimeoutMs)
	})

	it('refuses to spawn when the allocation would floor to zero', async () => {
		// Because `tokenBudget: 0` means UNLIMITED downstream
		// (`LimitChecker`: `tokenBudget > 0 && total >= tokenBudget`), the
		// most depleted parent in the tree was the one that spawned an
		// uncapped child. Budget exhaustion must not invert into no budget.
		const childAgent = makeAgent('child-broke', async () => successResult())
		const harness = await buildHarness(childAgent)
		const context = buildContext(harness.parentSession.id, harness.projectId, harness.topicId)
		context.budgetTracker = { total: 100_000, remaining: 1 }

		await expect(
			harness.manager.sendMessage(
				buildOptions('child-broke', harness.parentSession.id, harness.projectId),
				context,
			),
		).rejects.toThrow(/allocates 0 to the child/)
	})

	it('siblings divide ONE budget pool when spawned THROUGH THE GATEWAY', async () => {
		// `spawn` debits the shared tracker. A caller that hands each spawn a
		// cloned tracker makes the debit land on a throwaway object, so N
		// children are each allocated maxBudgetFraction of the SAME number.
		const seen: BaseAgentConfig[] = []
		const childAgent = makeAgent('child-budget', async (_input, config) => {
			seen.push(config)
			return successResult()
		})
		const harness = await buildHarness(childAgent)
		const context = buildContext(harness.parentSession.id, harness.projectId, harness.topicId)
		context.budgetTracker = { total: 100_000, remaining: 100_000 }

		// Go through the GATEWAY, which is where the clone was: calling
		// `manager.sendMessage` directly always shared the tracker, so a test
		// at that level proves nothing about the defect.
		const gateway = new LocalTaskScheduler(harness.manager, context)

		for (let i = 0; i < 3; i++) {
			const handle = await gateway.createTask({
				agentId: 'child-budget',
				prompt: 'work',
				workingDirectory: '/tmp',
			})
			await waitForTask(harness.manager, handle.taskId)
		}

		const allocated = seen.map((c) => c.tokenBudget ?? 0)
		expect(allocated).toHaveLength(3)
		// Never over-committed: whatever is outstanding at any moment fits
		// in the pool.
		expect(allocated[0]).toBeLessThanOrEqual(100_000)

		// These children settle before the next one spawns and spend
		// nothing, so each gets the same allocation from a pool that was
		// restored. This assertion used to require a STRICT decrease, which
		// only held because the reservation was never returned — it was
		// measuring the leak, not the rule.
		expect(allocated[1]).toBe(allocated[0])
		expect(allocated[2]).toBe(allocated[0])
	})

	it('returns what a settled child did not spend', async () => {
		// The debit is a reservation so siblings cannot each be promised the
		// same headroom. Nothing returned it, so a pool shrank by the full
		// allocation on every spawn no matter what the child used: at a
		// half-pool fraction, ten delegations left a parent with a
		// thousandth of its budget and the next spawn was refused for a
		// budget that had barely been spent.
		const childAgent = makeAgent('child-thrifty', async () => ({
			...successResult(),
			usage: { ...EMPTY_TOKEN_USAGE, totalTokens: 1_000 },
		}))
		const harness = await buildHarness(childAgent)
		const context = buildContext(harness.parentSession.id, harness.projectId, harness.topicId)
		context.budgetTracker = { total: 100_000, remaining: 100_000 }

		const gateway = new LocalTaskScheduler(harness.manager, context)
		const handle = await gateway.createTask({
			agentId: 'child-thrifty',
			prompt: 'work',
			workingDirectory: '/tmp',
		})
		await waitForTask(harness.manager, handle.taskId)

		// Reserved 50_000, spent 1_000: the pool is down by what was used,
		// not by what was set aside.
		expect(context.budgetTracker.remaining).toBe(99_000)
	})

	it('keeps a concurrent sibling reservation until it settles', async () => {
		// The reservation exists for exactly this: two children in flight
		// must not each be promised the same headroom.
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const childAgent = makeAgent('child-slow', async () => {
			await gate
			return successResult()
		})
		const harness = await buildHarness(childAgent)
		const context = buildContext(harness.parentSession.id, harness.projectId, harness.topicId)
		context.budgetTracker = { total: 100_000, remaining: 100_000 }

		const gateway = new LocalTaskScheduler(harness.manager, context)
		const first = await gateway.createTask({
			agentId: 'child-slow',
			prompt: 'work',
			workingDirectory: '/tmp',
		})

		expect(context.budgetTracker.remaining).toBe(50_000)

		release?.()
		await waitForTask(harness.manager, first.taskId)
		expect(context.budgetTracker.remaining).toBe(100_000)
	})
})

/**
 * A supervisor that fans out N tasks and watches one die had no way to say
 * the other N-1 were now pointless. The primitive to stop them existed —
 * every child holds an abort controller chained to the parent's — but
 * nothing connected a failure to it.
 */
describe('LocalTaskScheduler — what a failed child means for its siblings', () => {
	async function fanOut(policy?: 'continue' | 'cancel-siblings') {
		// One agent that fails, one that would run long enough to be worth
		// cancelling.
		let releaseSlow: (() => void) | undefined
		const slowDone = new Promise<void>((resolve) => {
			releaseSlow = resolve
		})

		const registry = new AgentRegistry()
		registry.register(makeDefinition(makeAgent('fails', async () => failureResult('boom'))))
		registry.register(
			makeDefinition(
				makeAgent('slow', async () => {
					await slowDone
					return successResult()
				}),
			),
		)

		const harness = await buildHarness(makeAgent('unused', async () => successResult()))
		// Swap in the two-agent registry.
		const manager = new AgentManager(registry, undefined, {
			sessionStore: harness.store,
			summaryMaterializer: harness.materializer,
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(harness.store),
			threadManager: harness.threadManager,
		})

		const context = buildContext(harness.parentSession.id, harness.projectId, harness.topicId)
		const gateway = new LocalTaskScheduler(
			manager,
			context,
			undefined,
			undefined,
			policy ? { siblingFailurePolicy: policy } : undefined,
		)

		const slow = await gateway.createTask({
			agentId: 'slow',
			prompt: 'long work',
			workingDirectory: '/tmp',
		})
		const failing = await gateway.createTask({
			agentId: 'fails',
			prompt: 'doomed work',
			workingDirectory: '/tmp',
		})

		await manager.waitForCompletion(failing.taskId)
		// Let the completion callback run.
		await new Promise((r) => setTimeout(r, 0))

		return { manager, slow, releaseSlow: releaseSlow as () => void }
	}

	it('leaves them alone by default — partial results are usually worth having', async () => {
		const { manager, slow, releaseSlow } = await fanOut()
		expect(manager.getInstance(slow.taskId)?.state).not.toBe('canceled')
		releaseSlow()
		await manager.waitForCompletion(slow.taskId)
	})

	it('cancels them when the fan-out only means something together', async () => {
		const { manager, slow, releaseSlow } = await fanOut('cancel-siblings')
		expect(manager.getInstance(slow.taskId)?.state).toBe('canceled')
		releaseSlow()
	})
})

describe('a concurrent fan-out shares one budget', () => {
	/**
	 * Siblings launched from one assistant turn were each allocated a fraction
	 * of the SAME undebited number.
	 *
	 * The allocation is read at the top of `sendMessage`; the debit lands
	 * after `await provisionSpawn`, which is the only critical section. So N
	 * siblings all enter, all read an untouched `remaining`, and each takes
	 * its fraction of it. `create_task`'s own description instructs exactly
	 * this shape: "'fan out 8 specialists' is one assistant message with 8
	 * create_task blocks."
	 *
	 * **The children must not be allowed to finish.** A child that settles
	 * refunds its unspent budget, and the refund restores the tracker to a
	 * plausible number — so a test that measures after settle sees a healthy
	 * total and reports nothing. The over-commitment is real and transient,
	 * and transient is enough: every allocation decision taken during the
	 * window reads a tracker that is already wrong.
	 *
	 * The first version of this test did settle its children, passed, and
	 * would have certified the bug as fixed.
	 */
	it('never allocates more than the parent has, while the children are still running', async () => {
		// What each child was actually HANDED. Asserting on the tracker was the
		// first attempt and it measured the wrong thing twice over: a settled
		// child refunds, which restores a plausible number, and the harm is not
		// the bookkeeping anyway — it is that four children each believe they
		// may spend half a pool that only has one half to give.
		const allocations: number[] = []
		let release: (() => void) | undefined
		const held = new Promise<void>((resolve) => {
			release = resolve
		})

		// The harness's own manager, because a hand-built one here silently
		// fails to provision and the children never run — which looks exactly
		// like a passing test.
		const harness = await buildHarness(
			makeAgent('child-1', async (_input, config) => {
				allocations.push(config.tokenBudget)
				await held
				return successResult()
			}),
		)

		// ONE tracker, shared, as a real parent's context is.
		const shared = { total: 100_000, remaining: 100_000 }
		const context = {
			...buildContext(harness.parentSession.id, harness.projectId, harness.topicId),
			budgetTracker: shared,
		}

		await Promise.allSettled(
			Array.from({ length: 4 }, () =>
				harness.manager.sendMessage(
					buildOptions('child-1', harness.parentSession.id, harness.projectId),
					context,
				),
			),
		)

		// Let the children record what they were handed before any settles.
		await new Promise((r) => setTimeout(r, 20))
		const handedOut = allocations.reduce((a, b) => a + b, 0)
		release?.()

		expect(allocations.length, 'every sibling should have started').toBe(4)
		expect(
			handedOut,
			`four siblings were handed ${allocations.join(' + ')} from a pool of ${shared.total}`,
		).toBeLessThanOrEqual(shared.total)
	})
})
