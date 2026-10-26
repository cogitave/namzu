import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'
import { QueryAgent } from '../../../agents/QueryAgent.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionPaths } from '../../../session/paths.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import type { AgentInput, BaseAgentConfig } from '../../../types/agent/base.js'
import type { Agent } from '../../../types/agent/core.js'
import type { AgentDefinition } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { TenantId, UserId } from '../../../types/ids/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { generateSummaryId, generateTurnId } from '../../../utils/id.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

export const tenant = '8ba3d942-8e73-4a21-a61b-ec011a8d39dd' as TenantId
export const actor: ActorRef = {
	kind: 'user',
	tenantId: tenant,
	userId: 'b20af1a4-f3de-4c3a-a746-4c7b72830fdb' as UserId,
}
export const managers: AgentManager[] = []
const dirs: string[] = []
afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose()
	for (const dir of dirs.splice(0)) await removeTempDirAsync(dir)
})

export function required<T>(value: T | null | undefined): T {
	if (value === undefined || value === null) throw new Error('Missing test fixture value')
	return value
}

export async function harness(options?: {
	disk?: boolean
	/** A new manager over the stores, layout and parent session of an earlier harness, as after a restart. */
	restartOf?: {
		readonly store: InMemorySessionStore
		readonly topics: InMemoryTopicStore
		readonly project: Awaited<ReturnType<InMemorySessionStore['createProject']>>
		readonly topic: Awaited<ReturnType<InMemoryTopicStore['createTopic']>>
		readonly parent: Awaited<ReturnType<InMemorySessionStore['createSession']>>
		readonly paths: SessionPaths | undefined
	}
	run?: Agent['run']
	provider?: MockLLMProvider
}) {
	const store = options?.restartOf?.store ?? new InMemorySessionStore()
	const topics = options?.restartOf?.topics ?? new InMemoryTopicStore()
	const topicManager = new TopicManager({
		topicStore: topics,
		sessionStore: store,
	})
	const project =
		options?.restartOf?.project ??
		(await store.createProject({ tenantId: tenant, name: 'continuation' }, tenant))
	const topic =
		options?.restartOf?.topic ??
		(await topics.createTopic({ projectId: project.id, title: 'child history' }, tenant))
	const parent =
		options?.restartOf?.parent ??
		(await store.createSession(
			{
				topicId: topic.id,
				projectId: project.id,
				currentActor: actor,
			},
			tenant,
		))
	if (!options?.restartOf) await store.updateSession({ ...parent, status: 'active' }, tenant)
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
	let paths: SessionPaths | undefined = options?.restartOf?.paths
	if (options?.disk && !paths) {
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
