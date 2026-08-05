import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ProviderErrorInfo } from '../provider/index.js'
import type { AgentRunConfig } from './config.js'
import type { ReplayAttribution } from './replay.js'
import type { StepResult } from './step.js'
import type { StopReason } from './stop-reason.js'

export interface RunStateMetadata {
	agentId: string
	agentName: string
	config: AgentRunConfig
	provider: string
}

export type SessionMetadata = RunStateMetadata

/**
 * Domain Run entity — the persistence record for a single agent invocation
 * under a {@link import('../session/entity.js').Session}. Renamed from
 * `AgentRun` on 2026-04-21 (ses_010 commit 7) to match the 5-layer hierarchy
 * (`Project → Thread → Session → SubSession → Run`) ratified in ses_001.
 *
 * The wire counterpart is `WireRun` under `contracts/api.ts` — the two stay
 * decoupled so the HTTP field shape can evolve independently from this
 * persistence record. See `docs/sdk/sessions/` for the public hierarchy
 * reference.
 */
export interface Run {
	id: RunId
	status: AgentStatus
	metadata: RunStateMetadata
	messages: Message[]
	tokenUsage: TokenUsage
	costInfo: CostInfo
	currentIteration: number
	startedAt: number
	endedAt?: number
	stopReason?: StopReason
	lastError?: string
	lastProviderError?: ProviderErrorInfo
	result?: string

	/**
	 * Per-iteration record of what the loop did. Absent on a run that
	 * never entered the loop.
	 *
	 * A host that persists the returned `Run` used to lose all per-step
	 * attribution: "which step cost the most" required correlating raw
	 * RunEvents by iteration and diffing cumulative counters.
	 */
	steps?: readonly StepResult[]

	/**
	 * Schema-validated final output, when `structuredOutput` was requested
	 * and the model produced one. Absent otherwise — check `stopReason`
	 * for `structured_output_failed`.
	 */
	structuredOutput?: unknown

	/**
	 * Delegated tasks that were still running when this run ended.
	 *
	 * A run can settle while a worker it launched is still going — the model
	 * answered, a terminal tool decided the result, a `stopWhen` fired. The
	 * worker is NOT cancelled: giving up on a wait is a statement about the
	 * waiter, not about the work, and killing a child that may be mid-write
	 * because its parent finished early is a policy only the host can judge.
	 * A host that wants them stopped has `cancel_task` and the run controller.
	 *
	 * What the kernel owes instead is not pretending the results arrived.
	 * These ids are the honest form of that: the run says which work it walked
	 * away from, so a host can reconcile, cancel, or wait on them itself.
	 * Absent when a run ended with nothing outstanding.
	 */
	abandonedTaskIds?: readonly string[]

	parentRunId?: RunId

	depth?: number

	/**
	 * Present when this run was produced by {@link replay}. `undefined` for
	 * original runs. See `ses_005-deterministic-replay` for the primitive.
	 */
	replayOf?: ReplayAttribution
}

/**
 * @deprecated Use {@link Run}. Alias retained for the 0.4.x compatibility
 * window; scheduled for removal in a later session.
 */
export type AgentRun = Run

/**
 * @deprecated Use {@link Run}. Alias retained for the 0.4.x compatibility
 * window; scheduled for removal in a later session.
 */
export type AgentSession = Run
