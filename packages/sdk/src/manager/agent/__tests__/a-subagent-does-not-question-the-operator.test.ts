import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { SupervisorAgent } from '../../../agents/SupervisorAgent.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryTopicStore } from '../../../store/topic/memory.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { ResumeHandler } from '../../../types/hitl/index.js'
import type { TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import { TopicManager } from '../../topic/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

/**
 * The complete child-capability boundary.
 *
 * `resumeHandler` cannot simply be withheld from a child: the same channel
 * carries REVIEW-tier tool authorization, and losing it silently restores the
 * runtime's unattended auto-approval fallback. The question capability must be
 * removed from the provider manifest while the handler still reaches ordinary
 * tool review.
 *
 * This drives the real AgentManager -> fixed configBuilder -> SupervisorAgent
 * -> query -> provider path. A unit test on the supervisor's depth check passes
 * even when AgentManager lets a fixed builder discard that depth, which was the
 * actual escape at this boundary.
 */

const TENANT = 'tnt_root_question' as TenantId
const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const actor = (tenantId: TenantId): ActorRef =>
	({ kind: 'user', userId: 'usr_root', tenantId }) as unknown as ActorRef

function hostTool(name: string, execute = vi.fn(async () => ({ success: true, output: 'ok' }))) {
	return {
		tool: defineTool({
			name,
			description: `host tool ${name}`,
			inputSchema: z.object({}),
			category: 'custom',
			permissions: [],
			readOnly: name !== 'review_probe',
			destructive: name === 'review_probe',
			concurrencySafe: true,
			execute,
		}),
		execute,
	}
}

describe('a subagent cannot question the operator', () => {
	it('withholds every same-named tool while preserving exact human review', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-child-question-'))
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
				{
					toolCalls: [
						{
							id: 'call_review',
							name: 'review_probe',
							rawArguments: '{}',
						},
					],
				},
				{ text: 'reviewed' },
			],
		})
		const question = hostTool('ask_user_question')
		const review = hostTool('review_probe')
		const tools = new ToolRegistry()
		tools.register(question.tool)
		tools.register(review.tool)

		const registry = new AgentRegistry()
		const child = new SupervisorAgent({
			id: 'child-supervisor',
			name: 'Child Supervisor',
			version: '1',
			category: 'test',
			description: 'delegated coordinator',
		})

		const manager = new AgentManager(registry, undefined, {
			sessionStore: store,
			threadManager: new TopicManager({ topicStore, sessionStore: store }),
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
			summaryMaterializer: new SessionSummaryMaterializer({
				store,
				generateSummaryId: () => 'sum_child_question' as never,
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
			// Deliberately fixed: the manager must stamp lineage AFTER this
			// returns. Most registered builders in this repository have this
			// shape and ignore fields they did not know to forward.
			configBuilder: () => ({
				provider,
				agentIds: [],
				agentManager: manager,
				tools,
				systemPrompt: 'Coordinate without asking the operator directly.',
				model: 'mock-model',
				tokenBudget: 100_000,
				timeoutMs: 30_000,
				maxIterations: 4,
			}),
		} as never)

		const resumeHandler = vi.fn(
			async (
				_request: Parameters<ResumeHandler>[0],
			): Promise<Awaited<ReturnType<ResumeHandler>>> => ({ action: 'approve_tools' }),
		)
		const context: AgentTaskContext = {
			parentRunId: 'run_root' as never,
			parentAgentId: 'root-supervisor',
			parentAbortController: new AbortController(),
			depth: 0,
			budgetTracker: { total: 100_000, remaining: 100_000 },
			resumeHandler,
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
					messages: [createUserMessage('do the delegated work')],
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

		const names = (provider.requests[0]?.tools ?? []).map((tool) => tool.function.name)
		expect(names).toContain('review_probe')
		expect(names).not.toContain('ask_user_question')
		const reviews = resumeHandler.mock.calls
			.map(([request]) => request)
			.filter((request) => request.type === 'tool_review')
		expect(reviews).toHaveLength(1)
		expect(reviews[0]).toMatchObject({
			type: 'tool_review',
			toolCalls: [{ name: 'review_probe' }],
		})
		expect(resumeHandler.mock.calls.map(([request]) => request.type)).not.toContain('user_question')
		expect(review.execute).toHaveBeenCalledTimes(1)
		expect(manager.getState(task.taskId)).toBe('completed')

		manager.dispose()
	})
})
