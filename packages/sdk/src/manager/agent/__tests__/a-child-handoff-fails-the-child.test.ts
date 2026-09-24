import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { SessionTokenBudget } from '../../../store/budget/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { SupervisorAgent } from '../../../agents/SupervisorAgent.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * A tool's request for a person inside a delegated child.
 *
 * Nobody resumes a child's turn: its parent is waiting on a result. So the
 * child fails with the reason, and the parent gets an ordinary failed child
 * result it can read, through the real AgentManager -> SupervisorAgent ->
 * query path.
 */

const TENANT = 'ce6d0071-5a0a-4b31-80b0-c5edbd9b88f9' as TenantId
const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const actor = (tenantId: TenantId): ActorRef =>
	({
		kind: 'user',
		userId: 'e04738b9-b828-4251-9b35-bc3bc8a2adf8',
		tenantId,
	}) as unknown as ActorRef

const REASON = 'Sign in to example.test, then continue.'

describe('a handoff inside a delegated child', () => {
	it('fails the child with the reason instead of pausing it', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-child-handoff-'))
		dirs.push(workingDirectory)

		const store = new InMemorySessionStore()
		const topicStore = new InMemoryTopicStore()
		const project = await store.createProject({ tenantId: TENANT, name: 'p' }, TENANT)
		const topic = await topicStore.createTopic({ projectId: project.id, title: 't' }, TENANT)
		const parentActor = actor(TENANT)
		const parent = await store.createSession(
			{ topicId: topic.id, projectId: project.id, currentActor: parentActor },
			TENANT,
		)
		await store.updateSession({ ...parent, status: 'active' }, TENANT)

		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'call_page', name: 'open_page', rawArguments: '{}' }] },
				{ text: 'never asked' },
			],
		})
		const execute = vi.fn(async () => ({
			success: false,
			output: 'sign-in page',
			error: 'sign-in required',
			handoff: { kind: 'human-required' as const, reason: REASON },
		}))
		const tools = testToolset(
			defineTool({
				name: 'open_page',
				description: 'open a page',
				inputSchema: z.object({}),
				category: 'custom',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute,
			}),
		)

		const registry = new AgentRegistry()
		const child = new SupervisorAgent({
			id: 'child-worker',
			name: 'Child Worker',
			version: '1',
			category: 'test',
			description: 'delegated worker',
		})
		const manager = new AgentManager(registry, undefined, {
			sessionStore: store,
			threadManager: new TopicManager({ topicStore, sessionStore: store }),
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
			summaryMaterializer: new SessionSummaryMaterializer({
				store,
				generateSummaryId: () => 'cad397a3-add4-4032-9202-427109b1c6c9' as never,
			}),
		})
		registry.register({
			info: {
				id: child.metadata.id,
				name: child.metadata.name,
				version: child.metadata.version,
				category: child.metadata.category,
				description: child.metadata.description,
				tools: [],
				defaults: { model: 'mock-model', tokenBudget: 100_000 },
			},
			typedAgent: child,
			configBuilder: () => ({
				provider,
				agentIds: [],
				agentManager: manager,
				toolsets: [tools],
				systemPrompt: 'Do the delegated work.',
				model: 'mock-model',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: 4,
			}),
		} as never)

		const context: AgentTaskContext = {
			parentSessionId: parent.id,
			parentTurnId: '0199a3c2-7c1e-7b4a-9d2f-5e6a7b8c9d0e' as never,
			parentAgentId: 'root-supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budget: SessionTokenBudget.create(100_000, {
				rootSessionId: generateSessionId(),
				rootTurnId: generateTurnId(),
			}),
			resumeHandler: async () => ({ action: 'approve_tools' }),
			tenantId: TENANT,
			topicId: topic.id,
			sessionId: parent.id,
			projectId: project.id,
			parentActor,
		}

		const task = await manager.sendMessage(
			{
				agentId: child.metadata.id,
				input: {
					messages: [createUserMessage('open the page')],
					workingDirectory,
				},
				parentSessionId: parent.id,
				tenantId: TENANT,
				projectId: project.id,
				parentActor,
			} as never,
			context,
		)
		await manager.waitForCompletion(task.taskId)

		expect(execute).toHaveBeenCalledTimes(1)
		expect(provider.requests).toHaveLength(1)
		const result = manager.getInstance(task.taskId)?.result
		expect(result?.status).toBe('failed')
		expect(result?.lastError).toContain(REASON)

		manager.dispose()
	})
})
