import type { ActorRef } from '../../session/hierarchy/actor.js'
import type { WorkspaceBackendKind } from '../../session/workspace/ref.js'
import type { TokenUsage } from '../common/index.js'
import type { RunId, SessionId, TaskId, TenantId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { RunEventListener } from '../run/events.js'
import type { ProjectId } from '../session/ids.js'
import type { AgentInput, BaseAgentConfig, BaseAgentResult } from './base.js'
import type { Agent } from './core.js'
import type { AgentFactoryOptions } from './factory.js'

export type AgentTaskState =
	| 'pending'
	| 'running'
	| 'completed'
	| 'failed'
	| 'canceled'
	| 'rejected'
	| 'input-required'

export function isTerminalAgentTaskState(state: AgentTaskState): boolean {
	return state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected'
}

/**
 * Context carried into {@link AgentManager.sendMessage}. `tenantId`,
 * `sessionId`, `projectId`, and `parentActor` are required — the spawn path
 * is the ingress point for the session hierarchy; callers must provide the
 * full scoping set.
 */
export interface AgentTaskContext {
	parentRunId: RunId

	parentAgentId: string

	parentAbortController: AbortController

	depth: number

	budgetTracker: AgentTaskBudget

	factoryOptions?: AgentFactoryOptions

	/** Isolation boundary. Required per session-hierarchy.md §12.1. */
	tenantId: TenantId

	/**
	 * Parent session under which any sub-agent spawn is recorded. Required
	 * in 0.2.0; a spawn cannot be attributed without it.
	 */
	sessionId: SessionId

	/** Long-lived goal scope. Required. */
	projectId: ProjectId

	/**
	 * The actor invoking this task. Children built off this context stamp
	 * their own `parentActor: ActorRef` linking back via the actor chain
	 * (session-hierarchy.md §4.3 / §10.4).
	 */
	parentActor: ActorRef
}

export interface AgentTaskBudget {
	total: number

	remaining: number
}

export interface AgentTask {
	taskId: TaskId
	agentId: string
	agent: Agent<BaseAgentConfig, BaseAgentResult>
	childAbortController: AbortController
	context: AgentTaskContext
	state: AgentTaskState
	result?: BaseAgentResult
	progress?: AgentTaskProgress

	pendingMessages: Message[]
	createdAt: number
	completedAt?: number

	evictAfter?: number

	runEventListener?: RunEventListener
}

export interface AgentTaskProgress {
	toolUseCount: number
	usage: TokenUsage
	recentActivities: string[]
}

/**
 * Options accepted by {@link AgentManager.sendMessage}. Phase 6 adds the
 * required sub-session spawn scope (`parentSessionId`, `tenantId`, `projectId`,
 * `parentActor`) so the manager can create a SubSession + child Session +
 * WorkspaceRef triple atomically on every spawn.
 */
export interface SendMessageOptions {
	agentId: string

	input: AgentInput

	configOverrides?: Partial<BaseAgentConfig>

	budgetAllocation?: {
		tokenBudget?: number
		timeoutMs?: number
	}

	/**
	 * Parent session under which the new sub-session is created. Capacity
	 * validation (depth + width) is applied against this session.
	 */
	parentSessionId: SessionId

	tenantId: TenantId

	projectId: ProjectId

	/** The actor requesting the spawn — seeds the child's `parentActor`. */
	parentActor: ActorRef

	/**
	 * Workspace backend to provision for the child session. Defaults to
	 * `git-worktree` — the MVP reference backend from Phase 3.
	 */
	workspaceBackend?: WorkspaceBackendKind
}

export interface AgentManagerConfig {
	maxDepth: number

	evictionMs: number

	maxBudgetFraction: number
}
