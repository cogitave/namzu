import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { QueryAgent } from '../../../agents/QueryAgent.js'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { LocalTaskScheduler } from '../../../scheduler/local.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionPaths } from '../../../session/paths.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { AgentInput, BaseAgentConfig, BaseAgentResult } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { TenantId, UserId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { generateSessionId, generateSummaryId, generateTurnId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

const tenant = '8ba3d942-8e73-4a21-a61b-ec011a8d39dd' as TenantId
const actor: ActorRef = {
	kind: 'user',
	tenantId: tenant,
	userId: 'b20af1a4-f3de-4c3a-a746-4c7b72830fdb' as UserId,
}
const managers: AgentManager[] = []
const dirs: string[] = []
afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose()
	for (const dir of dirs.splice(0)) await removeTempDirAsync(dir)
})

function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) throw new Error('Missing test fixture value')
	return value
}

async function harness(options?: {
	disk?: boolean
	run?: Agent['run']
	provider?: MockLLMProvider
}) {
	const store = new InMemorySessionStore()
	const topics = new InMemoryTopicStore()
	const topicManager = new TopicManager({
		topicStore: topics,
		sessionStore: store,
	})
	const project = await store.createProject({ tenantId: tenant, name: 'continuation' }, tenant)
	const topic = await topics.createTopic({ projectId: project.id, title: 'child history' }, tenant)
	const parent = await store.createSession(
		{
			topicId: topic.id,
			projectId: project.id,
			currentActor: actor,
		},
		tenant,
	)
	await store.updateSession({ ...parent, status: 'active' }, tenant)
	const provider =
		options?.provider ??
		new MockLLMProvider({
			turns: [{ text: 'original answer' }, { text: 'follow-up answer' }],
		})
	const configs: BaseAgentConfig[] = []
	const builderControl: { fail: boolean; onBuild?: () => void } = { fail: false }
	const shell = () =>
		new QueryAgent({
			id: 'worker',
			name: 'Worker',
			type: 'test',
			version: '1',
			category: 'test',
			description: 'test child',
		})
	const typedAgent = shell()
	const definition: AgentDefinition = {
		info: {
			id: 'worker',
			name: 'Worker',
			version: '1',
			category: 'test',
			description: 'test child',
			tools: [],
			defaults: { model: 'mock', tokenBudget: 1_000 },
		},
		typedAgent,
		createAgent: () => {
			const agent = shell()
			return {
				...agent,
				type: agent.type,
				metadata: agent.metadata,
				getCapabilities: () => agent.getCapabilities(),
				cancel: () => agent.cancel(),
				run: async (input: AgentInput, config: BaseAgentConfig, listener) => {
					configs.push(config)
					return options?.run
						? options.run(input, config, listener)
						: agent.run(input, { ...config, provider, toolsets: [] }, listener)
				},
			}
		},
		configBuilder: (factory) => {
			builderControl.onBuild?.()
			if (builderControl.fail) throw new Error('fresh config failed')
			return {
				model: 'mock',
				tokenBudget: factory.tokenBudget ?? 1_000,
				timeoutMs: 30_000,
				maxIterations: 3,
				maxResponseTokens: 100,
				permissionMode: 'plan',
			}
		},
	}
	const registry = new AgentRegistry()
	registry.register(definition)
	let paths: SessionPaths | undefined
	if (options?.disk) {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-child-continuation-'))
		dirs.push(dir)
		paths = new SessionPaths({ home: dir, slug: 'continuation' })
	}
	const manager = new AgentManager(
		registry,
		{ workspaceDefault: 'shared' },
		{
			sessionStore: store,
			topicManager,
			summaryMaterializer: new SessionSummaryMaterializer({
				store,
				generateSummaryId,
			}),
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
			...(paths ? { paths } : {}),
		},
	)
	managers.push(manager)
	const context = (): AgentTaskContext => ({
		parentSessionId: parent.id,
		sessionId: parent.id,
		parentTurnId: generateTurnId(),
		parentAgentId: 'parent',
		parentActor: actor,
		parentAbortController: new AbortController(),
		depth: 0,
		budget: SessionTokenBudget.create(10_000, {
			rootSessionId: parent.id,
			rootTurnId: generateTurnId(),
		}),
		tenantId: tenant,
		projectId: project.id,
		topicId: topic.id,
		...(paths
			? { childStorage: { kind: 'disk' as const, paths } }
			: { childStorage: { kind: 'memory' as const } }),
	})
	const taskOptions = {
		agentId: 'worker',
		prompt: 'original request',
		workingDirectory: '/tmp',
		workspace: { mode: 'shared' as const },
	}
	return {
		store,
		topics,
		project,
		topic,
		parent,
		manager,
		registry,
		definition,
		provider,
		configs,
		builderControl,
		context,
		taskOptions,
		paths,
	}
}

describe('child conversation continuation', () => {
	it('uses owner CAS when takeover happens after the continuation edge is provisioned', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		const original = await gateway.waitForTask(first.taskId)
		const id = required(first.childSessionId)
		const createEdge = h.store.createSubSession.bind(h.store)
		vi.spyOn(h.store, 'createSubSession').mockImplementationOnce(async (...args) => {
			const edge = await createEdge(...args)
			const session = required(await h.store.getSession(id, tenant))
			await h.store.updateSession(
				{
					...session,
					currentActor: actor,
					ownerVersion: session.ownerVersion + 1,
					status: 'active',
				},
				tenant,
				session.ownerVersion,
			)
			return edge
		})
		await expect(gateway.createTask({ ...h.taskOptions, resumeSessionId: id })).rejects.toThrow(
			'Stale',
		)
		expect(await h.store.getSession(id, tenant)).toMatchObject({
			ownerVersion: 1,
			currentActor: actor,
			status: 'active',
		})
		expect(await h.store.getChildren(h.parent.id, tenant)).toHaveLength(1)
		expect(gateway.getTask(first.taskId)).toEqual(original)
		expect(h.provider.requests).toHaveLength(1)
	})

	it.each(['configuration-failure', 'pre-run'] as const)(
		'preserves a takeover during %s and refuses the old owner',
		async (phase) => {
			const h = await harness()
			const gateway = new LocalTaskScheduler(h.manager, h.context())
			const first = await gateway.createTask(h.taskOptions)
			await gateway.waitForTask(first.taskId)
			const id = required(first.childSessionId)
			const original = required(await h.store.getSession(id, tenant))
			let takeover: Promise<void> | undefined
			h.builderControl.fail = phase === 'configuration-failure'
			h.builderControl.onBuild = () => {
				takeover = h.store.updateSession(
					{
						...original,
						ownerVersion: original.ownerVersion + 1,
						currentActor: actor,
						status: 'active',
					},
					tenant,
					original.ownerVersion,
				)
			}
			await expect(gateway.createTask({ ...h.taskOptions, resumeSessionId: id })).rejects.toThrow(
				phase === 'configuration-failure' ? 'fresh config failed' : 'ownership changed',
			)
			await takeover
			expect(await h.store.getSession(id, tenant)).toMatchObject({
				ownerVersion: 1,
				currentActor: actor,
				status: 'active',
			})
			expect(await h.store.getChildren(h.parent.id, tenant)).toHaveLength(1)
			expect(h.provider.requests).toHaveLength(1)
		},
	)

	it('does not idle or seal a new owner when takeover happens before invocation summary persistence', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		await gateway.waitForTask(first.taskId)
		const id = required(first.childSessionId)
		const oldSummary = await h.store.getSummary(id, tenant)
		const record = h.store.recordSummary.bind(h.store)
		vi.spyOn(h.store, 'recordSummary').mockImplementationOnce(async (...args) => {
			const child = required(await h.store.getSession(id, tenant))
			await h.store.updateSession(
				{ ...child, currentActor: actor, ownerVersion: child.ownerVersion + 1, status: 'active' },
				tenant,
				child.ownerVersion,
			)
			return record(...args)
		})
		const next = await gateway.createTask({ ...h.taskOptions, resumeSessionId: id })
		const failed = await gateway.waitForTask(next.taskId)
		expect(failed.state).toBe('failed')
		expect(await h.store.getSession(id, tenant)).toMatchObject({
			ownerVersion: 1,
			currentActor: actor,
			status: 'active',
		})
		expect(await h.store.getSummary(id, tenant)).toEqual(oldSummary)
		expect(await h.store.getSummary(id, tenant, required(failed.result?.turnId))).toBeNull()
	})

	it('uses owner CAS again when takeover races the failed-admission rollback write', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		await gateway.waitForTask(first.taskId)
		const id = required(first.childSessionId)
		const update = h.store.updateSession.bind(h.store)
		vi.spyOn(h.store, 'updateSession').mockImplementation(async (...args) => {
			if (args[0].id === id && args[0].status === 'idle' && args[2] !== undefined) {
				await update(
					{ ...args[0], ownerVersion: 1, currentActor: actor, status: 'active' },
					tenant,
					0,
				)
			}
			return update(...args)
		})
		h.builderControl.fail = true
		await expect(gateway.createTask({ ...h.taskOptions, resumeSessionId: id })).rejects.toThrow(
			'Stale',
		)
		expect(await h.store.getSession(id, tenant)).toMatchObject({
			ownerVersion: 1,
			currentActor: actor,
			status: 'active',
		})
		expect(await h.store.getChildren(h.parent.id, tenant)).toHaveLength(1)
		expect(h.provider.requests).toHaveLength(1)
	})

	it('requires explicit owner-CAS support from a continuation store', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		await gateway.waitForTask(first.taskId)
		Object.defineProperty(h.store, 'supportsOwnerVersionCas', { value: undefined })
		await expect(
			gateway.createTask({ ...h.taskOptions, resumeSessionId: first.childSessionId }),
		).rejects.toThrow('does not support child conversation')
	})
	it('keeps the conversation and folded history while admitting a fresh task and current authority', async () => {
		const h = await harness()
		const firstContext = h.context()
		const firstGateway = new LocalTaskScheduler(h.manager, firstContext)
		const first = await firstGateway.createTask(h.taskOptions)
		const original = await firstGateway.waitForTask(first.taskId)
		expect(original.state).toBe('completed')
		expect(original.childSessionId).toBeDefined()
		const firstEdge = (await h.store.getChildren(h.parent.id, tenant))[0]
		const originalSummary = await h.store.getSummary(required(original.childSessionId), tenant)
		const current = {
			...h.context(),
			reviewAllowedCalls: () => true,
			toolDenies: ['bash'],
		}
		const gateway = new LocalTaskScheduler(h.manager, current)
		const next = await gateway.createTask({
			...h.taskOptions,
			prompt: 'follow-up request',
			resumeSessionId: original.childSessionId,
		})
		const completed = await gateway.waitForTask(next.taskId)
		expect(completed.state).toBe('completed')
		expect(next.taskId).not.toBe(first.taskId)
		expect(next.childSessionId).toBe(original.childSessionId)
		expect(firstGateway.getTask(first.taskId)).toEqual(original)
		expect(h.provider.requests).toHaveLength(2)
		const messages = h.provider.requests[1]?.messages ?? []
		expect(messages.map((message) => message.content)).toContain('original request')
		expect(messages.map((message) => message.content)).toContain('original answer')
		expect(messages.map((message) => message.content)).toContain('follow-up request')
		expect(h.configs[1]?.reviewAllowedCalls?.()).toBe(true)
		expect(h.configs[1]?.deniedTools).toContain('bash')
		expect(h.manager.getInstance(next.taskId)?.context.parentTurnId).toBe(current.parentTurnId)
		expect(h.manager.getInstance(next.taskId)?.context.budget).not.toBe(
			h.manager.getInstance(first.taskId)?.context.budget,
		)
		const edges = await h.store.getChildren(h.parent.id, tenant)
		expect(edges).toHaveLength(2)
		expect(edges[0]).toEqual(firstEdge)
		expect(edges[1]?.childSessionId).toBe(original.childSessionId)
		expect(edges[1]?.id).not.toBe(firstEdge?.id)
		expect(edges[1]?.status).toBe('idle')
		expect(edges[1]?.summaryRef).not.toBe(firstEdge?.summaryRef)
		const currentSummary = await h.store.getSummary(
			required(next.childSessionId),
			tenant,
			required(completed.result?.turnId),
		)
		expect(currentSummary?.agentSummary).toBe('follow-up answer')
		expect(currentSummary?.id).toBe(edges[1]?.summaryRef)
		expect(await h.store.getSummary(required(original.childSessionId), tenant)).toEqual(
			originalSummary,
		)
		expect((await h.store.getSession(required(original.childSessionId), tenant))?.status).toBe(
			'idle',
		)
		expect(await h.store.getAncestry(required(original.childSessionId), tenant)).toEqual([
			h.parent.id,
			original.childSessionId,
		])
		await expect(gateway.continueTask(first.taskId, 'resurrect')).rejects.toThrow('terminal')
	})

	it('preserves disk log and immutable origin metadata across parent turns', async () => {
		const h = await harness({ disk: true })
		const origin = h.context()
		const firstGateway = new LocalTaskScheduler(h.manager, origin)
		const first = await firstGateway.createTask(h.taskOptions)
		await firstGateway.waitForTask(first.taskId)
		const id = required(first.childSessionId)
		const path = required(h.paths).subagentMeta({ sessionId: h.parent.id }, id)
		const before = JSON.parse(await readFile(path, 'utf8'))
		const nextGateway = new LocalTaskScheduler(h.manager, h.context())
		const next = await nextGateway.createTask({
			...h.taskOptions,
			prompt: 'continue',
			resumeSessionId: id,
		})
		await nextGateway.waitForTask(next.taskId)
		const after = JSON.parse(await readFile(path, 'utf8'))
		expect(after.parentTurnId).toBe(origin.parentTurnId)
		expect(after.toolCallId).toBe(before.toolCallId)
		expect(after.createdAt).toBe(before.createdAt)
		expect(after.status).toBe('completed')
		expect(h.provider.requests[1]?.messages.map((message) => message.content)).toContain(
			'original answer',
		)
	})

	it('can follow a failed child turn with a fresh invocation and a fresh immutable summary', async () => {
		const provider = new MockLLMProvider({
			turns: [{ error: { message: 'invalid request', status: 400 } }, { text: 'recovered answer' }],
		})
		const h = await harness({ provider })
		const firstGateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await firstGateway.createTask(h.taskOptions)
		expect((await firstGateway.waitForTask(first.taskId)).result?.status).toBe('failed')
		const firstEdge = (await h.store.getChildren(h.parent.id, tenant))[0]
		expect(firstEdge?.status).toBe('failed')
		const nextGateway = new LocalTaskScheduler(h.manager, h.context())
		const next = await nextGateway.createTask({
			...h.taskOptions,
			resumeSessionId: first.childSessionId,
			prompt: 'repair request',
		})
		const done = await nextGateway.waitForTask(next.taskId)
		expect(done.result?.status).toBe('completed')
		expect(done.childSessionId).toBe(first.childSessionId)
		const edges = await h.store.getChildren(h.parent.id, tenant)
		expect(edges[0]).toEqual(firstEdge)
		expect(edges[1]?.status).toBe('idle')
		expect(
			(
				await h.store.getSummary(
					required(first.childSessionId),
					tenant,
					required(done.result?.turnId),
				)
			)?.agentSummary,
		).toBe('recovered answer')
	})

	it('rechecks current host admission and closed project before touching retained history', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		await gateway.waitForTask(first.taskId)
		await expect(
			gateway.createTask({
				...h.taskOptions,
				resumeSessionId: first.childSessionId,
				beforeStart: async () => {
					throw new Error('parent authority revoked')
				},
			}),
		).rejects.toThrow('parent authority revoked')
		expect(h.provider.requests).toHaveLength(1)
		expect(await h.store.getChildren(h.parent.id, tenant)).toHaveLength(1)
		await h.store.setProjectStatus(h.project.id, 'archived', tenant, h.project.ownerVersion)
		await expect(
			gateway.createTask({ ...h.taskOptions, resumeSessionId: first.childSessionId }),
		).rejects.toThrow('archived')
		expect(h.provider.requests).toHaveLength(1)
	})

	it('rejects unknown or another manager’s saved child and a replaced agent definition', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		await expect(
			gateway.createTask({
				...h.taskOptions,
				resumeSessionId: generateSessionId(),
			}),
		).rejects.toThrow('authority')
		const first = await gateway.createTask(h.taskOptions)
		await gateway.waitForTask(first.taskId)
		const other = new AgentManager(h.registry, undefined, {
			sessionStore: h.store,
			topicManager: new TopicManager({
				topicStore: h.topics,
				sessionStore: h.store,
			}),
			summaryMaterializer: new SessionSummaryMaterializer({
				store: h.store,
				generateSummaryId,
			}),
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(h.store),
		})
		managers.push(other)
		await expect(
			new LocalTaskScheduler(other, h.context()).createTask({
				...h.taskOptions,
				resumeSessionId: first.childSessionId,
			}),
		).rejects.toThrow('authority')
		h.registry.unregister('worker')
		h.registry.register({ ...h.definition })
		await expect(
			gateway.createTask({
				...h.taskOptions,
				resumeSessionId: first.childSessionId,
			}),
		).rejects.toThrow('unchanged agent')
	})

	it('rejects a store without invocation-summary support before launching a follow-up', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		await gateway.waitForTask(first.taskId)
		Object.defineProperty(h.store, 'supportsInvocationSummaries', { value: undefined })
		await expect(
			gateway.createTask({ ...h.taskOptions, resumeSessionId: first.childSessionId }),
		).rejects.toThrow('does not support child conversation')
		expect(h.provider.requests).toHaveLength(1)
		expect(await h.store.getChildren(h.parent.id, tenant)).toHaveLength(1)
	})

	it('rejects a different parent and changed cwd, workspace, scope or child ownership', async () => {
		const h = await harness()
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		await gateway.waitForTask(first.taskId)
		const resume = { ...h.taskOptions, resumeSessionId: first.childSessionId }
		await expect(gateway.createTask({ ...resume, workingDirectory: '/var/tmp' })).rejects.toThrow(
			'working directory',
		)
		await expect(
			gateway.createTask({
				...resume,
				workspace: { mode: 'isolated', backend: 'git-worktree' },
			}),
		).rejects.toThrow('shared workspace')
		const parent = await h.store.createSession(
			{ projectId: h.project.id, topicId: h.topic.id, currentActor: actor },
			tenant,
		)
		const otherContext = {
			...h.context(),
			parentSessionId: parent.id,
			sessionId: parent.id,
		}
		await expect(
			new LocalTaskScheduler(h.manager, otherContext).createTask(resume),
		).rejects.toThrow('owning parent')
		const child = await h.store.getSession(required(first.childSessionId), tenant)
		await h.store.updateSession(
			{ ...required(child), ownerVersion: required(child).ownerVersion + 1 },
			tenant,
		)
		await expect(gateway.createTask(resume)).rejects.toThrow('ownership')
		expect(await h.store.getChildren(h.parent.id, tenant)).toHaveLength(1)
	})

	it('does not overlap a running child or one canceled before its invocation settles', async () => {
		let finish!: (result: BaseAgentResult) => void
		let ran!: () => void
		let invocations = 0
		const started = new Promise<void>((resolve) => {
			ran = resolve
		})
		const h = await harness({
			run: async (_input, config) => {
				if (++invocations > 1)
					return {
						sessionId: required(config.sessionId),
						turnId: generateTurnId(),
						status: 'completed',
						usage: { ...EMPTY_TOKEN_USAGE },
						cost: { ...ZERO_COST },
						iterations: 0,
						durationMs: 0,
						messages: [],
					}
				ran()
				return new Promise<BaseAgentResult>((resolve) => {
					finish = resolve
				})
			},
		})
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		let releaseSettled!: () => void
		const settled = new Promise<void>((resolve) => {
			releaseSettled = resolve
		})
		const unsubscribe = gateway.onChildSessionEvent((event) => {
			if (event.type === 'child_session_idled') releaseSettled()
		})
		const first = await gateway.createTask(h.taskOptions)
		await started
		const resume = { ...h.taskOptions, resumeSessionId: first.childSessionId }
		await expect(gateway.createTask(resume)).rejects.toThrow('running or settling')
		gateway.cancelTask(first.taskId, 'user')
		expect(gateway.getTask(first.taskId)?.state).toBe('canceled')
		await expect(gateway.createTask(resume)).rejects.toThrow('running or settling')
		finish({
			sessionId: required(first.childSessionId),
			turnId: generateTurnId(),
			status: 'cancelled',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 0,
			durationMs: 0,
			messages: [],
		})
		await settled
		unsubscribe()
		const next = await gateway.createTask(resume)
		expect((await gateway.waitForTask(next.taskId)).state).toBe('completed')
		expect(next.taskId).not.toBe(first.taskId)
		expect(next.childSessionId).toBe(first.childSessionId)
		expect(gateway.getTask(first.taskId)?.state).toBe('canceled')
	})

	it('rolls back only a failed follow-up admission, preserving the original conversation and task', async () => {
		const h = await harness({ disk: true })
		const gateway = new LocalTaskScheduler(h.manager, h.context())
		const first = await gateway.createTask(h.taskOptions)
		const original = await gateway.waitForTask(first.taskId)
		const id = required(first.childSessionId)
		const log = required(h.paths).sessionLog({
			sessionId: id,
			ancestors: [h.parent.id],
		})
		const before = await readFile(log, 'utf8')
		h.builderControl.fail = true
		await expect(
			gateway.createTask({
				...h.taskOptions,
				resumeSessionId: id,
			}),
		).rejects.toThrow('fresh config failed')
		expect(await readFile(log, 'utf8')).toBe(before)
		expect(await h.store.getSession(id, tenant)).not.toBeNull()
		expect(await h.store.getChildren(h.parent.id, tenant)).toHaveLength(1)
		expect(gateway.getTask(first.taskId)).toEqual(original)
		h.builderControl.fail = false
		const next = await gateway.createTask({
			...h.taskOptions,
			resumeSessionId: id,
			prompt: 'retry',
		})
		expect((await gateway.waitForTask(next.taskId)).state).toBe('completed')
	})
})
