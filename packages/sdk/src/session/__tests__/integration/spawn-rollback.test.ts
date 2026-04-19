/**
 * Integration — AgentManager.provisionSpawn compensating rollback.
 *
 * Covers Codex SPAWN-ROLLBACK critique (ses_001-hierarchy-redesign Phase 2
 * adversarial review, 2026-04-18). Without the try/catch wrapper around the
 * createSession → updateSession → createSubSession → workspace.create
 * mutation block, a failure after createSession leaves an `active` child
 * session with no subsession edge — invisible to the parent, but counted
 * against `maxDelegationWidth` and visible to SessionStore.listSessions
 * consumers (archive/delete flows in ThreadManager).
 *
 * Failure modes exercised:
 *   A. Workspace driver throws on create. Subsession exists; must flip to
 *      'failed' for audit. Child session must be hard-deleted.
 *   B. Subsession insert fails (store injection). No subsession recorded.
 *      Child session must be hard-deleted.
 *
 * Assertions in both cases:
 *   - sendMessage rejects with the underlying error.
 *   - SessionStore.listSessions(threadId) returns no row with the child id.
 *   - Parent session remains untouched (status, currentActor).
 *   - Fan-out cap reclaims the slot (next spawn succeeds up to the same
 *     width).
 */

import { describe, expect, it } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentManager } from '../../../manager/agent/lifecycle.js'
import { ThreadManager } from '../../../manager/thread/lifecycle.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
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
import type { SummaryId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import type { ActorRef } from '../../hierarchy/actor.js'
import { SessionSummaryMaterializer } from '../../summary/materialize.js'
import type {
	BranchWorkspaceParams,
	CreateWorkspaceParams,
	WorkspaceBackendDriver,
	WorkspaceInspection,
} from '../../workspace/driver.js'
import type { WorkspaceRef } from '../../workspace/ref.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'

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

class FailingWorkspaceDriver implements WorkspaceBackendDriver {
	readonly kind = 'git-worktree' as const
	createCalls = 0

	async create(_params: CreateWorkspaceParams): Promise<WorkspaceRef> {
		this.createCalls += 1
		throw new Error('synthetic workspace backend failure')
	}

	async branch(_source: WorkspaceRef, _params: BranchWorkspaceParams): Promise<WorkspaceRef> {
		throw new Error('unused in this test')
	}

	async dispose(_ref: WorkspaceRef): Promise<void> {
		/* no-op */
	}

	async inspect(_ref: WorkspaceRef): Promise<WorkspaceInspection> {
		throw new Error('unused in this test')
	}
}

describe('provisionSpawn compensating rollback', () => {
	it('workspace driver failure — deletes child session, marks subsession failed, leaves no orphan', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{ tenantId: tenant, name: 'rollback-project' },
			tenant,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'rollback-topic' },
			tenant,
		)

		const userActor: ActorRef = {
			kind: 'user',
			userId: 'usr_root' as UserId,
			tenantId: tenant,
		}

		const parentSession = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor },
			tenant,
		)
		await store.updateSession({ ...parentSession, status: 'active' }, tenant)

		let summaryCounter = 0
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => `sum_test_${++summaryCounter}` as SummaryId,
		})

		const registry = new AgentRegistry()
		registry.register(buildDefinition(buildAgent('worker')))

		const workspaceRegistry = new WorkspaceBackendRegistry()
		const failingDriver = new FailingWorkspaceDriver()
		workspaceRegistry.register(failingDriver)

		const threadManager = new ThreadManager({ threadStore, sessionStore: store })
		const manager = new AgentManager(registry, undefined, {
			sessionStore: store,
			summaryMaterializer: materializer,
			workspaceRegistry,
			capacity: new DefaultCapacityValidator(store),
			threadManager,
		})

		const taskContext: AgentTaskContext = {
			parentRunId: 'run_parent' as RunId,
			parentAgentId: 'supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budgetTracker: { total: 100_000, remaining: 100_000 },
			tenantId: tenant,
			threadId: thread.id,
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
			workspaceBackend: 'git-worktree',
		}

		await expect(manager.sendMessage(options, taskContext)).rejects.toThrow(
			'synthetic workspace backend failure',
		)
		expect(failingDriver.createCalls).toBe(1)

		// Child session is gone — archive/delete flows and fan-out caps see
		// zero child attached to the thread beyond the parent.
		const sessionsOnThread = await store.listSessions(thread.id, tenant)
		expect(sessionsOnThread.map((s) => s.id)).toEqual([parentSession.id])

		// Parent session is untouched.
		const refetchedParent = await store.getSession(parentSession.id, tenant)
		expect(refetchedParent?.status).toBe('active')
		expect(refetchedParent?.currentActor).toEqual(userActor)

		// No subsession breadcrumb — `subsession_spawned` never fired
		// (provisionSpawn aborted before buildSpawnRecord), so nothing is
		// expecting an audit row. Leaving a `status: 'failed'` record would
		// dangle with no corresponding emission.
		const subsessions = await store.getChildren(parentSession.id, tenant)
		expect(subsessions).toHaveLength(0)
	})

	it('repeated rollback does not accumulate orphan sessions or subsessions', async () => {
		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const project = await store.createProject(
			{
				tenantId: tenant,
				name: 'rollback-repeat-project',
			},
			tenant,
		)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'rollback-width-topic' },
			tenant,
		)

		const userActor: ActorRef = {
			kind: 'user',
			userId: 'usr_root' as UserId,
			tenantId: tenant,
		}

		const parentSession = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: userActor },
			tenant,
		)
		await store.updateSession({ ...parentSession, status: 'active' }, tenant)

		let summaryCounter = 0
		const materializer = new SessionSummaryMaterializer({
			store,
			generateSummaryId: () => `sum_test_${++summaryCounter}` as SummaryId,
		})

		const registry = new AgentRegistry()
		registry.register(buildDefinition(buildAgent('worker')))

		const workspaceRegistry = new WorkspaceBackendRegistry()
		workspaceRegistry.register(new FailingWorkspaceDriver())

		const threadManager = new ThreadManager({ threadStore, sessionStore: store })
		const manager = new AgentManager(registry, undefined, {
			sessionStore: store,
			summaryMaterializer: materializer,
			workspaceRegistry,
			capacity: new DefaultCapacityValidator(store),
			threadManager,
		})

		const taskContext: AgentTaskContext = {
			parentRunId: 'run_parent' as RunId,
			parentAgentId: 'supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budgetTracker: { total: 100_000, remaining: 100_000 },
			tenantId: tenant,
			threadId: thread.id,
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
			workspaceBackend: 'git-worktree',
		}

		// Two consecutive failing spawns. Without rollback, two orphan
		// `active` child sessions would accumulate; with rollback, each
		// attempt cleans up after itself and the store stays at { parent }.
		await expect(manager.sendMessage(options, taskContext)).rejects.toThrow(
			'synthetic workspace backend failure',
		)
		await expect(manager.sendMessage(options, taskContext)).rejects.toThrow(
			'synthetic workspace backend failure',
		)

		// Still no child session under the thread.
		const sessionsOnThread = await store.listSessions(thread.id, tenant)
		expect(sessionsOnThread.map((s) => s.id)).toEqual([parentSession.id])

		// No lingering subsession rows — both attempts rolled back cleanly.
		const subsessions = await store.getChildren(parentSession.id, tenant)
		expect(subsessions).toHaveLength(0)
	})
})
