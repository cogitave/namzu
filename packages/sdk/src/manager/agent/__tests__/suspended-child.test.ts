// Current-code invariants asserted (2026-07-13, ses_017 post-review F3/F8):
//
// A child that parks on a durable decision is the case every cancel path forgot.
//
// - **F3.** `cancel(taskId)` aborted an AbortSignal nobody was listening to — the
//   child's generator had already returned — and `cancelDecision` had ZERO callers. So
//   the child's decision sat `pending` on disk, its run.json still said
//   `awaiting_input`, and anyone holding the resume token could still redeem it and run
//   the batch on a run the user believed they had cancelled. Cancel now reaches the
//   DURABLE record.
// - **F8.** `finalizeChild`'s `awaiting_input` arm returns before the `spawnRecord`
//   block, so a suspended child's sub-session stays `active` and its workspace is never
//   disposed — correct while it is parked (a resume needs that workspace), and a leak
//   the moment it is cancelled, because `markCanceled` disposed nothing either. The
//   cancel path now closes both.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { readPendingDecision } from '../../../runtime/query/decision/resume.js'
import { drainQuery } from '../../../runtime/query/index.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import type { WorkspaceBackendDriver } from '../../../session/workspace/driver.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { RunDiskStore } from '../../../store/run/disk.js'
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
import type { CheckpointId } from '../../../types/hitl/index.js'
import type { AgentId, RunId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import type { ChatCompletionParams, ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/events.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { ProjectId, SummaryId, ThreadId, WorkspaceId } from '../../../types/session/ids.js'
import type { ToolDefinition } from '../../../types/tool/index.js'
import type { WorkspaceRef } from '../../../types/workspace/ref.js'
import { ThreadManager } from '../../thread/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

const tenant = 'tnt_alpha' as TenantId
const PARENT_RUN = 'run_parent' as RunId

const capabilities: AgentCapabilities = {
	supportsTools: true,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}

function user(): ActorRef {
	return { kind: 'user', userId: 'usr_root' as UserId, tenantId: tenant }
}

function tmp(): string {
	return mkdtempSync(join(tmpdir(), 'namzu-suspended-child-'))
}

/** A child that runs a REAL query and parks it on a durable tool-review decision. */
class PausingChild implements Agent<BaseAgentConfig, BaseAgentResult> {
	readonly type = 'reactive' as const
	readonly metadata: AgentMetadata
	/** Tool executions, so a resurrected batch is visible. */
	readonly calls: string[] = []
	/** The checkpoint the child parked on. */
	checkpointId?: CheckpointId
	childRunId?: RunId

	constructor(id: string) {
		this.metadata = {
			type: 'reactive',
			id,
			name: id,
			version: '1.0.0',
			category: 'test',
			description: id,
			capabilities,
		}
	}

	async run(input: AgentInput, config: BaseAgentConfig): Promise<BaseAgentResult> {
		const tools = new ToolRegistry()
		const calls = this.calls
		tools.register({
			name: 'deploy',
			description: 'deploys',
			inputSchema: z.object({}).passthrough() as never,
			async execute() {
				calls.push('deploy')
				return { success: true, output: 'deployed' }
			},
		} as unknown as ToolDefinition)

		let turn = 0
		const run = await drainQuery(
			{
				provider: {
					id: 'fake',
					name: 'Fake',
					async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
						turn++
						if (turn === 1) {
							return {
								id: 'r',
								model: 'm',
								message: {
									role: 'assistant',
									content: 'deploying',
									toolCalls: [
										{
											id: 'call_1',
											type: 'function',
											function: { name: 'deploy', arguments: '{}' },
										},
									],
								},
								finishReason: 'tool_calls',
								usage: {
									promptTokens: 1,
									completionTokens: 1,
									totalTokens: 2,
									cachedTokens: 0,
									cacheWriteTokens: 0,
								},
							} as ChatCompletionResponse
						}
						return {
							id: 'r',
							model: 'm',
							message: { role: 'assistant', content: 'done' },
							finishReason: 'stop',
							usage: {
								promptTokens: 1,
								completionTokens: 1,
								totalTokens: 2,
								cachedTokens: 0,
								cacheWriteTokens: 0,
							},
						} as ChatCompletionResponse
					},
					// biome-ignore lint/correctness/useYield: stub, never invoked
					async *chatStream() {
						throw new Error('not used')
					},
				},
				tools,
				runConfig: { model: 'm', tokenBudget: 100_000, timeoutMs: 60_000, maxIterations: 3 },
				agentId: this.metadata.id,
				agentName: this.metadata.name,
				workingDirectory: input.workingDirectory,
				messages: input.messages,
				runId: config.runId,
				parentRunId: config.parentRunId,
				depth: config.depth,
				sessionId: config.sessionId as SessionId,
				threadId: config.threadId as ThreadId,
				projectId: config.projectId as ProjectId,
				tenantId: config.tenantId as TenantId,
				resumeHandler: async () => ({ action: 'pause', reason: 'child needs a human' }),
			},
			(event: RunEvent) => {
				if (event.type === 'run_paused') {
					this.checkpointId = (event as { checkpointId: CheckpointId }).checkpointId
				}
			},
		)

		this.childRunId = run.id
		return {
			runId: run.id,
			status: run.status,
			stopReason: run.stopReason,
			usage: run.tokenUsage,
			cost: run.costInfo,
			iterations: run.currentIteration,
			durationMs: 1,
			messages: run.messages,
		}
	}

	async cancel(): Promise<void> {}
	getCapabilities(): AgentCapabilities {
		return capabilities
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
			defaults: { model: 'test', tokenBudget: 1_000 },
		},
		typedAgent: agent,
	}
}

/** Records disposal so the workspace leak is observable. */
function fakeWorkspaceDriver(disposed: string[]): WorkspaceBackendDriver {
	let n = 0
	return {
		kind: 'git-worktree',
		async create(): Promise<WorkspaceRef> {
			const id = `wsp_${++n}` as WorkspaceId
			return {
				id,
				meta: {
					backend: 'git-worktree',
					repoRoot: '/repo',
					branch: `b_${id}`,
					worktreePath: `/repo/.worktrees/${id}`,
				},
				createdAt: new Date(),
			}
		},
		async dispose(ref: WorkspaceRef): Promise<void> {
			disposed.push(ref.id)
		},
	} as unknown as WorkspaceBackendDriver
}

async function buildHarness(child: Agent<BaseAgentConfig, BaseAgentResult>, cwd: string) {
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()
	const threadManager = new ThreadManager({ threadStore, sessionStore: store })
	const project = await store.createProject({ tenantId: tenant, name: 'p1' }, tenant)
	const thread = await threadStore.createThread(
		{ projectId: project.id, title: 'suspend-test' },
		tenant,
	)
	const parentSession = await store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: user() },
		tenant,
	)
	await store.updateSession({ ...parentSession, status: 'active' }, tenant)

	let counter = 0
	const materializer = new SessionSummaryMaterializer({
		store,
		generateSummaryId: () => `sum_test_${++counter}` as SummaryId,
	})

	const registry = new AgentRegistry()
	registry.register(makeDefinition(child))

	const disposed: string[] = []
	const workspaceRegistry = new WorkspaceBackendRegistry()
	workspaceRegistry.register(fakeWorkspaceDriver(disposed))

	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: materializer,
		workspaceRegistry,
		capacity: new DefaultCapacityValidator(store),
		threadManager,
	})

	const context: AgentTaskContext = {
		parentRunId: PARENT_RUN,
		parentAgentId: 'parent-agent' as AgentId,
		parentAbortController: new AbortController(),
		depth: 0,
		budgetTracker: { total: 100_000, remaining: 100_000 },
		tenantId: tenant,
		threadId: thread.id as ThreadId,
		sessionId: parentSession.id as SessionId,
		projectId: project.id as ProjectId,
		parentActor: user(),
	}

	const options: SendMessageOptions = {
		agentId: child.metadata.id,
		input: { messages: [], workingDirectory: cwd },
		parentSessionId: parentSession.id,
		tenantId: tenant,
		projectId: project.id,
		parentActor: user(),
	}

	return { manager, context, options, store, disposed, project, parentSession }
}

describe('AgentManager — cancelling a child that parked on a durable decision', () => {
	it('reaches the decision on disk: the run is cancelled and the token is spent', async () => {
		const cwd = tmp()
		const child = new PausingChild('child-1')
		const h = await buildHarness(child, cwd)

		const task = await h.manager.sendMessage(h.options, h.context)
		await h.manager.waitForCompletion(task.taskId)

		// The child parked. Not terminal — cancellable, and (once ses_019 lands) resumable.
		expect(h.manager.getState(task.taskId)).toBe('input-required')
		expect(child.calls).toEqual([])
		const checkpointId = child.checkpointId
		const childRunId = child.childRunId
		if (!checkpointId || !childRunId) throw new Error('child never parked')

		const baseDir = join(
			new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(
				h.context.projectId,
				// The child runs under its OWN session, minted by provisionSpawn.
				h.manager.getInstance(task.taskId)?.context.sessionId as SessionId,
			),
			'runs',
		)

		// Before the fix this was still `pending` on a run that still said
		// `awaiting_input`: a leaked token would have deployed to production on a run the
		// user had cancelled.
		await h.manager.cancel(task.taskId)

		const decision = await readPendingDecision({
			baseDir,
			runId: childRunId,
			parentRunId: PARENT_RUN,
			checkpointId,
		})
		expect(decision?.state).toBe('cancelled')

		const store = new RunDiskStore({ baseDir })
		await store.initRun(childRunId, PARENT_RUN)
		expect((await store.readRunMeta())?.status).toBe('cancelled')

		expect(h.manager.getState(task.taskId)).toBe('canceled')
		expect(child.calls).toEqual([])
	})

	it('disposes the parked child’s workspace and closes its sub-session', async () => {
		const cwd = tmp()
		const child = new PausingChild('child-1')
		const h = await buildHarness(child, cwd)

		const task = await h.manager.sendMessage(h.options, h.context)
		await h.manager.waitForCompletion(task.taskId)
		expect(h.manager.getState(task.taskId)).toBe('input-required')

		// While it is PARKED the workspace stays: a resume needs the very state disposing
		// it would destroy.
		expect(h.disposed).toEqual([])

		await h.manager.cancel(task.taskId)

		// Cancelled, though, means nobody is coming back — so the worktree is released and
		// the sub-session stops reading as `active`, which is what kept the parent session
		// from ever going idle.
		expect(h.disposed).toHaveLength(1)

		const spawnRecord = h.manager.getSpawnRecord(task.taskId)
		if (!spawnRecord) throw new Error('no spawn record')
		const subSession = await h.store.getSubSession(spawnRecord.subSessionId, tenant)
		expect(subSession?.status).not.toBe('active')
	})
})
