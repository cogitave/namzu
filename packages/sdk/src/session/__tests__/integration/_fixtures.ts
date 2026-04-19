/**
 * Shared test fixtures for the Task 10 integration coverage matrix.
 *
 * Factors out the `AgentManager` + `SessionStore` + `WorkspaceBackendRegistry`
 * + `SessionSummaryMaterializer` + `DefaultCapacityValidator` wiring that
 * every integration test rebuilds. Keeping this in an underscore-prefixed
 * internal module (Convention #4: `_fixtures.ts` does not bleed into any
 * barrel) lets the 11 integration files focus on invariant assertions rather
 * than boilerplate.
 *
 * DO NOT export from `src/session/index.ts` or any other public barrel.
 * This module is test-only and has no runtime consumers.
 */

import { vi } from 'vitest'
import { EMPTY_TOKEN_USAGE } from '../../../constants/limits.js'
import { AgentManager } from '../../../manager/agent/lifecycle.js'
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
import type { AgentId, RunId, SessionId, TenantId, UserId } from '../../../types/ids/index.js'
import { createAssistantMessage } from '../../../types/message/index.js'
import type { ProjectId, SummaryId, ThreadId } from '../../../types/session/ids.js'
import { ZERO_COST } from '../../../utils/cost.js'
import { DefaultCapacityValidator } from '../../handoff/capacity.js'
import type { ActorRef } from '../../hierarchy/actor.js'
import type { Session } from '../../hierarchy/session.js'
import { SessionSummaryMaterializer } from '../../summary/materialize.js'
import type { ExecFile, ExecFileResult } from '../../workspace/git-worktree.js'
import { GitWorktreeDriver } from '../../workspace/git-worktree.js'
import { WorkspaceBackendRegistry } from '../../workspace/registry.js'

export const DEFAULT_TENANT = 'tnt_alpha' as TenantId
export const OTHER_TENANT = 'tnt_beta' as TenantId

export function stubLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child() {
			return stubLogger()
		},
	}
}

export function okExec(stdout = '', stderr = ''): ExecFileResult {
	return { stdout, stderr }
}

export function userActor(userId: string, tenantId: TenantId = DEFAULT_TENANT): ActorRef {
	return { kind: 'user', userId: userId as UserId, tenantId }
}

export function agentActor(agentId: string, tenantId: TenantId = DEFAULT_TENANT): ActorRef {
	return { kind: 'agent', agentId: agentId as AgentId, tenantId }
}

const BASE_CAPABILITIES: AgentCapabilities = {
	supportsTools: false,
	supportsStreaming: false,
	supportsConcurrency: false,
	supportsSubAgents: false,
}

/**
 * Builds a minimal {@link Agent} whose `run` produces a deterministic
 * assistant message. Tests that need custom output shape override via
 * {@link buildAgentCustom}.
 */
export function buildAgent(
	id: string,
	result = 'child did the work',
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
			capabilities: BASE_CAPABILITIES,
		},
		run: async (_input: AgentInput, _config: BaseAgentConfig): Promise<BaseAgentResult> => ({
			runId: `run_${id}_result` as RunId,
			status: 'completed',
			usage: { ...EMPTY_TOKEN_USAGE },
			cost: { ...ZERO_COST },
			iterations: 1,
			durationMs: 1,
			messages: [createAssistantMessage(result)],
			result,
		}),
		cancel: async () => undefined,
		getCapabilities: () => BASE_CAPABILITIES,
	}
}

/**
 * Builds an agent with a caller-supplied `run`. Useful for tests that need
 * to simulate failures or spawn cascading agents.
 */
export function buildAgentCustom(
	id: string,
	run: Agent<BaseAgentConfig, BaseAgentResult>['run'],
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
			capabilities: BASE_CAPABILITIES,
		},
		run,
		cancel: async () => undefined,
		getCapabilities: () => BASE_CAPABILITIES,
	}
}

export function buildDefinition(agent: Agent<BaseAgentConfig, BaseAgentResult>): AgentDefinition {
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

export interface IntegrationHarness {
	readonly store: InMemorySessionStore
	readonly threadStore: InMemoryThreadStore
	readonly registry: AgentRegistry
	readonly manager: AgentManager
	readonly materializer: SessionSummaryMaterializer
	readonly workspaceRegistry: WorkspaceBackendRegistry
	readonly capacity: DefaultCapacityValidator
	readonly tenantId: TenantId
}

export interface IntegrationHarnessOptions {
	readonly tenantId?: TenantId
	/** Pass `true` to register a no-op stubbed git-worktree driver. */
	readonly withWorktreeDriver?: boolean
	readonly execFile?: ExecFile
	/**
	 * Deterministic summary ID generator — defaults to `sum_test_<n>`. Tests
	 * asserting on the exact id should override.
	 */
	readonly summaryIdGenerator?: () => SummaryId
}

/**
 * Builds a full AgentManager + SessionStore + Materializer harness wired with
 * real components (not mocks). The `GitWorktreeDriver` uses a stubbed
 * `execFile` that returns empty stdout by default — tests exercising failure
 * modes inject a real {@link ExecFile}.
 */
export function buildHarness(options: IntegrationHarnessOptions = {}): IntegrationHarness {
	const tenantId = options.tenantId ?? DEFAULT_TENANT
	const store = new InMemorySessionStore()
	const threadStore = new InMemoryThreadStore()

	const workspaceRegistry = new WorkspaceBackendRegistry()
	if (options.withWorktreeDriver !== false) {
		const exec: ExecFile = options.execFile ?? (async () => okExec())
		const driver = new GitWorktreeDriver({
			repoRoot: '/repo',
			logger: stubLogger(),
			execFile: exec,
		})
		workspaceRegistry.register(driver)
	}

	let counter = 0
	const generateSummaryId =
		options.summaryIdGenerator ?? (() => `sum_test_${++counter}` as SummaryId)

	const materializer = new SessionSummaryMaterializer({
		store,
		generateSummaryId,
	})

	const capacity = new DefaultCapacityValidator(store)
	const registry = new AgentRegistry()
	const manager = new AgentManager(registry, undefined, {
		sessionStore: store,
		summaryMaterializer: materializer,
		workspaceRegistry,
		capacity,
	})

	return {
		store,
		threadStore,
		registry,
		manager,
		materializer,
		workspaceRegistry,
		capacity,
		tenantId,
	}
}

/**
 * Seeds a Tenant → Project → Thread → Session quadruple and flips the session
 * into `active` so it is a legal spawn parent. Returns the project, thread,
 * and active session for the caller to drive spawns against.
 */
export async function seedActiveParent(
	harness: IntegrationHarness,
	options?: {
		actor?: ActorRef
		projectName?: string
		tenantId?: TenantId
		threadTitle?: string
	},
) {
	const tenantId = options?.tenantId ?? harness.tenantId
	const actor: ActorRef = options?.actor ?? userActor('usr_root', tenantId)
	const project = await harness.store.createProject(
		{ tenantId, name: options?.projectName ?? 'integration-project' },
		tenantId,
	)
	const thread = await harness.threadStore.createThread(
		{ projectId: project.id, title: options?.threadTitle ?? 'default' },
		tenantId,
	)
	const session = await harness.store.createSession(
		{ threadId: thread.id, projectId: project.id, currentActor: actor },
		tenantId,
	)
	await harness.store.updateSession({ ...session, status: 'active' as Session['status'] }, tenantId)
	return { project, thread, session, actor }
}

/**
 * Constructs a fully populated {@link AgentTaskContext} bound to the supplied
 * parent session + actor. Tests override individual fields (depth, budget)
 * by merging.
 */
export function buildTaskContext(params: {
	sessionId: SessionId
	projectId: ProjectId
	threadId?: ThreadId
	tenantId: TenantId
	parentActor: ActorRef
	depth?: number
	budget?: number
	parentRunId?: RunId
}): AgentTaskContext {
	return {
		parentRunId: params.parentRunId ?? ('run_parent' as RunId),
		parentAgentId: 'supervisor',
		parentAbortController: new AbortController(),
		depth: params.depth ?? 0,
		budgetTracker: {
			total: params.budget ?? 100_000,
			remaining: params.budget ?? 100_000,
		},
		tenantId: params.tenantId,
		sessionId: params.sessionId,
		projectId: params.projectId,
		parentActor: params.parentActor,
	}
}

export function buildSendMessageOptions(params: {
	agentId: string
	parentSessionId: SessionId
	projectId: ProjectId
	threadId?: ThreadId
	tenantId: TenantId
	parentActor: ActorRef
}): SendMessageOptions {
	return {
		agentId: params.agentId,
		input: { messages: [], workingDirectory: '/tmp' },
		parentSessionId: params.parentSessionId,
		tenantId: params.tenantId,
		projectId: params.projectId,
		parentActor: params.parentActor,
	}
}
