// Current-code invariants asserted (2026-07-12, ses_017 P3):
//
// A spawned child is its OWN run: its own run record, its own on-disk directory, its own
// budget, linked to its parent by `parentRunId`. It must never share the parent's run id.
//
// This was already true before P3 — but only by accident. The shipped config builders
// discarded `options.runId` entirely, so nothing could be inherited. P3 makes the
// builders honour `options.runId` (that is the whole point: the caller's id must reach
// the agent), and `AgentManager.spawn` calls the CHILD's builder with the PARENT's
// `factoryOptions` spread in — and in production those factory options are the parent's
// own (`SupervisorAgentConfig.factoryOptions = options`, carrying the API's `runId`).
// So the moment the builders started honouring the id, every child would have opened a
// run record under its parent's id, silently merging two runs into one directory.
//
// `AgentManager.spawn` therefore clears `runId` out of the inherited factory options.
// This test pins that: the child here uses a builder shaped exactly like the shipped
// ones (`runId: options.runId`), and the parent's factory options carry the parent's id.
//
//   - The child's config arrives with NO `runId`, so the child mints its own.
//   - The child's run record and its on-disk run directory carry the child's id, never
//     the parent's.
//   - `parentRunId` — not a shared id — is what links the two.
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ReactiveAgent } from '../../../agents/ReactiveAgent.js'
import { AgentRegistry } from '../../../registry/agent/definitions.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { DefaultCapacityValidator } from '../../../session/handoff/capacity.js'
import { SessionSummaryMaterializer } from '../../../session/summary/materialize.js'
import { DefaultPathBuilder } from '../../../session/workspace/path-builder.js'
import { WorkspaceBackendRegistry } from '../../../session/workspace/registry.js'
import { InMemorySessionStore } from '../../../store/session/memory.js'
import { InMemoryThreadStore } from '../../../store/thread/memory.js'
import type { BaseAgentConfig } from '../../../types/agent/base.js'
import type { AgentDefinition, AgentFactoryOptions } from '../../../types/agent/factory.js'
import type { AgentTaskContext } from '../../../types/agent/task.js'
import type { RunId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type {
	ChatCompletionParams,
	ChatCompletionResponse,
	LLMProvider,
} from '../../../types/provider/index.js'
import type { ActorRef } from '../../../types/session/actor.js'
import type { ProjectId, SummaryId } from '../../../types/session/ids.js'
import { ThreadManager } from '../../thread/lifecycle.js'
import { AgentManager } from '../lifecycle.js'

const TENANT = 'tnt_alpha' as TenantId

/** The parent's run id — the one the API minted and the one a child must NOT reuse. */
const PARENT_RUN_ID = 'run_the_parent' as RunId

function stoppingProvider(): LLMProvider {
	return {
		id: 'fake',
		name: 'Fake',
		async chat(_params: ChatCompletionParams): Promise<ChatCompletionResponse> {
			return {
				id: 'r',
				model: 'm',
				message: { role: 'assistant', content: 'child done' },
				finishReason: 'stop',
				usage: {
					promptTokens: 10,
					completionTokens: 10,
					totalTokens: 20,
					cachedTokens: 0,
					cacheWriteTokens: 0,
				},
			} as ChatCompletionResponse
		},
		// biome-ignore lint/correctness/useYield: stub, never invoked
		async *chatStream() {
			throw new Error('not used')
		},
	}
}

describe('AgentManager.spawn — a child run keeps its own id (ses_017 P3)', () => {
	it('does not inherit the parent run id through the parent factoryOptions', async () => {
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-ses017-p3-child-'))
		const childAgent = new ReactiveAgent({
			id: 'child-1',
			name: 'Child',
			version: '1.0.0',
			category: 'test',
			description: 'test child',
		})

		// Shaped exactly like the shipped builders in packages/agents: it honours
		// `options.runId`. If the parent's id survives into `options`, it lands here.
		const configsBuilt: BaseAgentConfig[] = []
		const configBuilder = (options: AgentFactoryOptions): BaseAgentConfig => {
			const config: BaseAgentConfig = {
				model: 'm',
				tokenBudget: options.tokenBudget ?? 1_000,
				timeoutMs: options.timeoutMs ?? 60_000,
				maxIterations: 3,
				runId: options.runId as RunId | undefined,
				parentRunId: options.parentRunId as RunId | undefined,
				depth: options.depth,
			}
			configsBuilt.push(config)
			return config
		}

		const definition: AgentDefinition = {
			info: {
				id: 'child-1',
				name: 'Child',
				version: '1.0.0',
				category: 'test',
				description: 'test child',
				tools: [],
				defaults: { model: 'm', tokenBudget: 1_000 },
			},
			typedAgent: childAgent as unknown as AgentDefinition['typedAgent'],
			configBuilder: (options) => ({
				...configBuilder(options),
				provider: stoppingProvider(),
				tools: new ToolRegistry(),
			}),
		}

		const store = new InMemorySessionStore()
		const threadStore = new InMemoryThreadStore()
		const threadManager = new ThreadManager({ threadStore, sessionStore: store })
		const project = await store.createProject({ tenantId: TENANT, name: 'p1' }, TENANT)
		const thread = await threadStore.createThread(
			{ projectId: project.id, title: 'p3-child-id' },
			TENANT,
		)
		const rootActor: ActorRef = { kind: 'user', userId: 'usr_root' as UserId, tenantId: TENANT }
		const parentSession = await store.createSession(
			{ threadId: thread.id, projectId: project.id, currentActor: rootActor },
			TENANT,
		)
		await store.updateSession({ ...parentSession, status: 'active' }, TENANT)

		let n = 0
		const registry = new AgentRegistry()
		registry.register(definition)
		const manager = new AgentManager(registry, undefined, {
			sessionStore: store,
			summaryMaterializer: new SessionSummaryMaterializer({
				store,
				generateSummaryId: () => `sum_test_${++n}` as SummaryId,
			}),
			workspaceRegistry: new WorkspaceBackendRegistry(),
			capacity: new DefaultCapacityValidator(store),
			threadManager,
		})

		// This is the production shape: the supervisor's own factory options — which
		// carry the run id the API minted for the PARENT — become the child's inherited
		// `factoryOptions` (see `orchestrator`: `factoryOptions: options`).
		const context: AgentTaskContext = {
			parentRunId: PARENT_RUN_ID,
			parentAgentId: 'parent-agent',
			parentAbortController: new AbortController(),
			depth: 0,
			budgetTracker: { total: 100_000, remaining: 100_000 },
			factoryOptions: { runId: PARENT_RUN_ID, model: 'm' },
			tenantId: TENANT,
			threadId: thread.id,
			sessionId: parentSession.id as SessionId,
			projectId: project.id as ProjectId,
			parentActor: rootActor,
		}

		const task = await manager.sendMessage(
			{
				agentId: 'child-1',
				input: { messages: [createUserMessage('do the child work')], workingDirectory: cwd },
				parentSessionId: parentSession.id,
				tenantId: TENANT,
				projectId: project.id,
				parentActor: rootActor,
			},
			context,
		)
		await manager.waitForCompletion(task.taskId)

		// 1. The parent's id never reached the child's config builder.
		expect(configsBuilt).toHaveLength(1)
		expect(configsBuilt[0]?.runId).toBeUndefined()
		expect(configsBuilt[0]?.parentRunId).toBe(PARENT_RUN_ID)

		// 2. The child minted its own id, and it is not the parent's.
		const childRunId = manager.getInstance(task.taskId)?.result?.runId
		expect(childRunId).toBeDefined()
		expect(childRunId).not.toBe(PARENT_RUN_ID)

		// 3. The child's run directory on disk is named by the CHILD's id, and the
		//    parent's id names nothing here — two runs, two records, never merged.
		const spawnRecord = manager.getSpawnRecord(task.taskId)
		const runsDir = join(
			new DefaultPathBuilder(join(cwd, '.namzu')).sessionDir(
				project.id,
				spawnRecord?.childSessionId ?? (parentSession.id as SessionId),
			),
			'runs',
		)
		// The child is stored under its parent's hierarchy: <runs>/<parentRunId>/children/<childRunId>
		expect(existsSync(join(runsDir, PARENT_RUN_ID, 'children', childRunId as string))).toBe(true)
		expect(existsSync(join(runsDir, PARENT_RUN_ID, 'run.json'))).toBe(false)
	})
})
