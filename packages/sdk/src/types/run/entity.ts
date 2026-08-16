import type { CostInfo, RunExecutionStatus, TokenUsage } from '../common/index.js'
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
	/**
	 * The provider the run was CONFIGURED with — the head of the chain, and
	 * the counterpart of `config.model` beside it.
	 *
	 * It is a declaration, not an observation, and it stays one. After a
	 * provider chain falls over it still names the head, which is correct for
	 * a field that answers "what was asked for"; it was only ever misleading
	 * because nothing else answered "what served". See {@link servingProvider}
	 * for the run-level answer and `steps[].servedBy` for the per-step one.
	 */
	provider: string
	/**
	 * The chain member the run was routed to at the end, when that is not the
	 * one it was configured with.
	 *
	 * Absent means the declared provider served every call. That reading holds
	 * for stored records too, with one bounded exception: the sdk major that
	 * shipped the chain could fall over without recording it, so a run from
	 * that release reads as "no swap" whether or not there was one. Its
	 * transcript still carries the `provider_fallback` events. The exception
	 * is one release wide and it is stated rather than migrated away, because
	 * a migration would have to invent the answer for exactly the records that
	 * do not have it.
	 *
	 * **This is the durable half.** `RunDiskStore.writeRunMeta` writes
	 * `metadata` and not `steps`, so on the built-in store this field is the
	 * whole of what survives the process. `steps[].servedBy` is the finer
	 * record — the one to read for "which member answered turn 4" — and it
	 * reaches a host only on the returned `Run`.
	 *
	 * It also covers the case no step ledger can: a run that falls over and
	 * then dies before a single step is recorded still has to be able to say
	 * whose failure ended it. That is why the wording is "routed to" and not
	 * "served by" — this member was asked, and on that path it answered with
	 * an error. It is never a member that was merely selected: the chain
	 * announces a replacement when it issues its request, not when it picks
	 * it, so a run cancelled at the swap notice does not name one.
	 */
	servingProvider?: string
}

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
	status: RunExecutionStatus
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
