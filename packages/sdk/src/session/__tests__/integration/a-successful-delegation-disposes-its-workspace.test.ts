/**
 * A worktree provisioned for a delegated child outlived the child that used it.
 *
 * `finalizeChild` had two dispose sites and both were failure paths — the
 * non-success branch, and the rollback in `failSubSession`. The success branch
 * disposed nothing, so `.namzu/worktrees/` grew once per successful delegation:
 * the more reliable the workers, the faster it filled.
 *
 * The backstop could not fire either. `ArchivalManager` resolves a workspace
 * only when `SubSession.workspaceId` is set, and for a spawn-created
 * sub-session that field was written `null` and never updated —
 * `provisionSpawn` kept the ref on the in-memory `ChildSpawnRecord` and nowhere
 * else. So the one record that could have named the leaked worktree said there
 * was none.
 *
 * Both halves are pinned here, and the failure path is re-asserted alongside
 * them: a test that only counted disposals would pass on the old code by
 * reading the failure branch's disposal and calling it the success branch's.
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
import type { RunId, TenantId, UserId, WorkspaceId } from '../../../types/ids/index.js'
import { createAssistantMessage } from '../../../types/message/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { SummaryId } from '../../../types/session/ids.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../summary/materialize.js'
import type {
	BranchWorkspaceParams,
	CreateWorkspaceParams,
	WorkspaceBackendDriver,
	WorkspaceInspection,
} from '../../workspace/driver.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'

const tenant = 'tnt_alpha' as TenantId

const capabilities: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}

/** A child that settles the way `outcome` says, so both branches are reachable. */
function buildAgent(
	id: string,
	outcome: 'completed' | 'failed',
): Agent<BaseAgentConfig, BaseAgentResult> {
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
			status: outcome,
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

/** Provisions successfully and records every ref it is asked to dispose. */
class RecordingWorkspaceDriver implements WorkspaceBackendDriver {
	readonly kind = 'git-worktree' as const
	readonly created: WorkspaceRef[] = []
	readonly disposed: WorkspaceId[] = []
	private counter = 0

	async create(params: CreateWorkspaceParams): Promise<WorkspaceRef> {
		const ref: WorkspaceRef = {
			id: `wsp_test_${++this.counter}` as WorkspaceId,
			meta: {
				backend: 'git-worktree',
				repoRoot: '/tmp/repo',
				branch: `namzu/${params.label ?? 'unlabelled'}`,
				worktreePath: `/tmp/repo/.namzu/worktrees/${params.label ?? 'unlabelled'}`,
			},
			createdAt: new Date(),
		}
		this.created.push(ref)
		return ref
	}

	async branch(_source: WorkspaceRef, _params: BranchWorkspaceParams): Promise<WorkspaceRef> {
		throw new Error('unused in this test')
	}

	async dispose(ref: WorkspaceRef): Promise<void> {
		this.disposed.push(ref.id)
	}

	async inspect(_ref: WorkspaceRef): Promise<WorkspaceInspection> {
		throw new Error('unused in this test')
	}
}

/**
 * Stands up a Project → Thread → parent Session and an AgentManager wired to a
 * recording workspace driver. `outcome` decides how the delegated child ends;
 * `registerBackend: false` leaves the registry empty, which is the supported
 * lazy-provisioning configuration rather than an error (pattern doc §7.1).
 */
async function harness(
	outcome: 'completed' | 'failed',
	{ registerBackend = true }: { registerBackend?: boolean } = {},
) {
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()
	const project = await store.createProject({ tenantId: tenant, name: 'workspace-project' }, tenant)
	const thread = await threadStore.createThread(
		{ projectId: project.id, title: 'workspace-topic' },
		tenant,
	)

	const userActor: ActorRef = { kind: 'user', userId: 'usr_root' as UserId, tenantId: tenant }

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
	registry.register(buildDefinition(buildAgent('worker', outcome)))

	const workspaceRegistry = new WorkspaceBackendRegistry()
	const driver = new RecordingWorkspaceDriver()
	if (registerBackend) workspaceRegistry.register(driver)

	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: materializer,
		workspaceRegistry,
		capacity: new DefaultCapacityValidator(store),
		threadManager: new ThreadManager({ threadStore, sessionStore: store }),
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

	return { store, manager, driver, parentSession, options, taskContext }
}

describe('a delegated child does not outlive its workspace', () => {
	it('disposes the workspace when the child SUCCEEDS', async () => {
		const { manager, driver, options, taskContext } = await harness('completed')

		const task = await manager.sendMessage(options, taskContext)
		await manager.waitForCompletion(task.taskId)

		expect(manager.getState(task.taskId)).toBe('completed')
		expect(driver.created).toHaveLength(1)
		// The assertion the leak fails: one workspace made, the same one released.
		expect(driver.disposed).toEqual([driver.created[0]?.id])
	})

	it('still disposes the workspace when the child FAILS', async () => {
		const { manager, driver, options, taskContext } = await harness('failed')

		const task = await manager.sendMessage(options, taskContext)
		await manager.waitForCompletion(task.taskId)

		expect(driver.created).toHaveLength(1)
		expect(driver.disposed).toEqual([driver.created[0]?.id])
	})

	it('records the workspace on the sub-session, so archival can find it', async () => {
		const { store, manager, driver, parentSession, options, taskContext } =
			await harness('completed')

		const task = await manager.sendMessage(options, taskContext)
		await manager.waitForCompletion(task.taskId)

		const [subSession] = await store.getChildren(parentSession.id, tenant)
		expect(subSession).toBeDefined()
		// Was `null` on every spawn-created sub-session, which is what made
		// `ArchivalManager`'s `sub.workspaceId &&` guard unreachable here.
		expect(subSession?.workspaceId).toBe(driver.created[0]?.id)
	})

	it('leaves workspaceId null when no backend is registered', async () => {
		// Lazy provisioning stays legal (pattern doc §7.1): an unregistered
		// backend is not an error, and the record must not claim a workspace
		// that was never made.
		const { store, manager, driver, parentSession, options, taskContext } = await harness(
			'completed',
			{ registerBackend: false },
		)

		const task = await manager.sendMessage(options, taskContext)
		await manager.waitForCompletion(task.taskId)

		expect(manager.getState(task.taskId)).toBe('completed')
		expect(driver.created).toHaveLength(0)
		const [subSession] = await store.getChildren(parentSession.id, tenant)
		expect(subSession?.workspaceId).toBeNull()
	})
})
