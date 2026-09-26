import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { fixtureUuid } from '../../../test-support/ids.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentManager } from '../../../manager/agent/lifecycle.js'
import { TopicManager } from '../../../manager/topic/lifecycle.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type {
	AgentCapabilities,
	AgentInput,
	BaseAgentConfig,
	BaseAgentResult,
} from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext, SendMessageOptions } from '../../../types/agent/task.js'
import type { SessionId, TenantId, TurnId, UserId, WorkspaceId } from '../../../types/ids/index.js'
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

const tenant = '62edaf4a-e86a-4e8e-bb39-662d7437216e' as TenantId
const fixtureRoots: string[] = []

afterEach(async () => {
	for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

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
		run: async (_input: AgentInput, config: BaseAgentConfig): Promise<BaseAgentResult> => ({
			sessionId: config.sessionId as SessionId,
			turnId: '4721e070-5ba2-425a-bf5a-8cc927907e9a' as TurnId,
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
		const repoRoot = await mkdtemp(join(tmpdir(), 'namzu-workspace-ref-'))
		fixtureRoots.push(repoRoot)
		const worktreePath = join(repoRoot, 'worktrees', params.label ?? 'unlabelled')
		await mkdir(worktreePath, { recursive: true })
		const ref: WorkspaceRef = {
			id: fixtureUuid(`wsp_test_${++this.counter}`) as WorkspaceId,
			meta: {
				backend: 'git-worktree',
				repoRoot,
				branch: `namzu/${params.label ?? 'unlabelled'}`,
				worktreePath,
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
	{
		registerBackend = true,
		workspaceDefault,
	}: { registerBackend?: boolean; workspaceDefault?: 'registered' | 'shared' } = {},
) {
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryTopicStore()
	const project = await store.createProject({ tenantId: tenant, name: 'workspace-project' }, tenant)
	const thread = await threadStore.createTopic(
		{ projectId: project.id, title: 'workspace-topic' },
		tenant,
	)

	const userActor: ActorRef = {
		kind: 'user',
		userId: 'e04738b9-b828-4251-9b35-bc3bc8a2adf8' as UserId,
		tenantId: tenant,
	}

	const parentSession = await store.createSession(
		{ topicId: thread.id, projectId: project.id, currentActor: userActor },
		tenant,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, tenant)

	let summaryCounter = 0
	const materializer = new SessionSummaryMaterializer({
		store,
		generateSummaryId: () => fixtureUuid(`sum_test_${++summaryCounter}`) as SummaryId,
	})

	const registry = new AgentRegistry()
	registry.register(buildDefinition(buildAgent('worker', outcome)))

	const workspaceRegistry = new WorkspaceBackendRegistry()
	const driver = new RecordingWorkspaceDriver()
	if (registerBackend) workspaceRegistry.register(driver)

	const manager = new AgentManager(
		registry,
		{ workspaceDefault },
		{
			sessionStore: store,
			summaryMaterializer: materializer,
			workspaceRegistry,
			capacity: new DefaultCapacityValidator(store),
			threadManager: new TopicManager({
				topicStore: threadStore,
				sessionStore: store,
			}),
		},
	)

	const taskContext: AgentTaskContext = {
		parentSessionId: parentSession.id,
		parentTurnId: 'c0250b29-330b-445f-b11d-2926ffd9059c' as TurnId,
		parentAgentId: 'supervisor',
		parentAbortController: new AbortController(),
		depth: 0,
		budget: SessionTokenBudget.create(100_000, {
			rootSessionId: generateSessionId(),
			rootTurnId: generateTurnId(),
		}),
		tenantId: tenant,
		topicId: thread.id,
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

	return { store, manager, driver, registry, parentSession, options, taskContext }
}

describe('a delegated child does not outlive its workspace', () => {
	it('uses an explicit task choice before its backend and manager defaults', async () => {
		const { manager, driver, options, taskContext } = await harness('completed', {
			workspaceDefault: 'shared',
		})

		const omitted = await manager.sendMessage(
			{ ...options, workspaceBackend: undefined },
			taskContext,
		)
		await manager.waitForCompletion(omitted.taskId)
		expect(driver.created).toHaveLength(0)

		const legacy = await manager.sendMessage(options, taskContext)
		await manager.waitForCompletion(legacy.taskId)
		expect(driver.created).toHaveLength(1)

		const explicit = await manager.sendMessage(
			{ ...options, workspace: { mode: 'shared' } },
			taskContext,
		)
		await manager.waitForCompletion(explicit.taskId)
		expect(driver.created).toHaveLength(1)
	})

	it.each([
		'wrong backend',
		'relative path',
		'caller path',
		'caller alias',
		'missing path',
	] as const)('refuses isolated admission when the driver returns a %s', async (invalid) => {
		const { store, manager, driver, parentSession, options, taskContext } =
			await harness('completed')
		const create = driver.create.bind(driver)
		vi.spyOn(driver, 'create').mockImplementationOnce(async (params) => {
			const ref = await create(params)
			const callerPath = await realpath(options.input.workingDirectory ?? process.cwd())
			const alias = join(ref.meta.repoRoot, 'caller-alias')
			if (invalid === 'caller alias') await symlink(callerPath, alias, 'dir')
			return {
				...ref,
				meta: {
					...ref.meta,
					...(invalid === 'wrong backend' ? { backend: 'shared' } : {}),
					...(invalid === 'relative path' ? { worktreePath: 'relative' } : {}),
					...(invalid === 'caller path' ? { worktreePath: '/tmp' } : {}),
					...(invalid === 'caller alias' ? { worktreePath: alias } : {}),
					...(invalid === 'missing path'
						? { worktreePath: join(ref.meta.repoRoot, 'missing') }
						: {}),
				},
			} as unknown as WorkspaceRef
		})

		await expect(
			manager.sendMessage(
				{ ...options, workspace: { mode: 'isolated', backend: 'git-worktree' } },
				taskContext,
			),
		).rejects.toThrow('invalid workspace ref or path')
		expect(driver.disposed).toEqual([driver.created[0]?.id])
		expect(await store.getChildren(parentSession.id, tenant)).toHaveLength(0)
	})

	it('starts an isolated child in its requested subdirectory and keeps the worktree root ref', async () => {
		const { manager, driver, registry, options, taskContext } = await harness('completed')
		const create = driver.create.bind(driver)
		vi.spyOn(driver, 'create').mockImplementationOnce(async (params) => {
			const ref = await create(params)
			await mkdir(join(ref.meta.worktreePath, 'packages', 'foo'), { recursive: true })
			return ref
		})
		let childCwd: string | undefined
		const agent = registry.getOrThrow('worker').typedAgent
		const run = agent.run.bind(agent)
		vi.spyOn(agent, 'run').mockImplementation(async (input, config, listener) => {
			childCwd = input.workingDirectory
			return run(input, config, listener)
		})

		const task = await manager.sendMessage(
			{
				...options,
				workspace: {
					mode: 'isolated',
					backend: 'git-worktree',
					subdirectory: 'packages/foo',
					retention: 'retain',
				},
			},
			taskContext,
		)
		await manager.waitForCompletion(task.taskId)

		const root = driver.created[0]?.meta.worktreePath
		if (!root) throw new Error('The recording driver did not create a worktree')
		expect(childCwd).toBe(join(root, 'packages', 'foo'))
		expect(task.workspace?.meta.worktreePath).toBe(root)
		expect(driver.disposed).toEqual([])
	})

	it.each(['escape', 'missing', 'outside symlink'] as const)(
		'rejects a %s subdirectory before isolated child admission',
		async (invalid) => {
			const { store, manager, driver, parentSession, options, taskContext } =
				await harness('completed')
			const create = driver.create.bind(driver)
			vi.spyOn(driver, 'create').mockImplementationOnce(async (params) => {
				const ref = await create(params)
				if (invalid === 'outside symlink') {
					const outside = await mkdtemp(join(tmpdir(), 'namzu-outside-worktree-'))
					fixtureRoots.push(outside)
					await symlink(outside, join(ref.meta.worktreePath, 'alias'), 'dir')
				}
				return ref
			})
			const subdirectory =
				invalid === 'escape' ? '../escape' : invalid === 'missing' ? 'missing' : 'alias'

			await expect(
				manager.sendMessage(
					{
						...options,
						workspace: { mode: 'isolated', backend: 'git-worktree', subdirectory },
					},
					taskContext,
				),
			).rejects.toThrow(/subdirectory/)
			expect(driver.disposed).toEqual([driver.created[0]?.id])
			expect(await store.getChildren(parentSession.id, tenant)).toHaveLength(0)
		},
	)
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

	it.each(['completed', 'failed'] as const)(
		'keeps an explicitly retained workspace after a %s child',
		async (outcome) => {
			const { store, manager, driver, parentSession, options, taskContext } = await harness(outcome)
			const task = await manager.sendMessage(
				{
					...options,
					workspace: { mode: 'isolated', backend: 'git-worktree', retention: 'retain' },
				},
				taskContext,
			)
			await manager.waitForCompletion(task.taskId)

			expect(driver.created).toHaveLength(1)
			expect(driver.disposed).toEqual([])
			expect(task.workspace?.id).toBe(driver.created[0]?.id)
			const [subSession] = await store.getChildren(parentSession.id, tenant)
			expect(subSession?.workspaceRetention).toBe('retain')
		},
	)

	it('removes an unadmitted checkout when its workspace record cannot be saved', async () => {
		const { store, manager, driver, options, taskContext } = await harness('completed')
		vi.spyOn(store, 'updateSubSession').mockRejectedValueOnce(new Error('workspace record failed'))

		await expect(
			manager.sendMessage(
				{
					...options,
					workspace: { mode: 'isolated', backend: 'git-worktree', retention: 'retain' },
				},
				taskContext,
			),
		).rejects.toThrow('workspace record failed')
		expect(driver.created).toHaveLength(1)
		expect(driver.disposed).toEqual([driver.created[0]?.id])
	})

	it('removes an unadmitted checkout when child configuration fails', async () => {
		const { manager, driver, registry, options, taskContext } = await harness('completed')
		registry.getOrThrow('worker').configBuilder = async () => {
			throw new Error('child configuration failed')
		}

		await expect(
			manager.sendMessage(
				{
					...options,
					workspace: { mode: 'isolated', backend: 'git-worktree', retention: 'retain' },
				},
				taskContext,
			),
		).rejects.toThrow('child configuration failed')
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
