import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { AgentRunConfig } from './config.js'
import type { AwaitingDecisionRef } from './emergency.js'
import type { ReplayAttribution } from './replay.js'
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
	result?: string

	parentRunId?: RunId

	depth?: number

	/**
	 * Set while the run is `awaiting_input` — a pointer to the decision it is parked on.
	 * Cleared by nothing: it names the last decision the run stopped for, and a resumed
	 * run either answers that decision or parks on a new one.
	 */
	awaitingDecision?: AwaitingDecisionRef

	/**
	 * Present when this run was produced by {@link replay}. `undefined` for
	 * original runs. See `ses_005-deterministic-replay` for the primitive.
	 */
	replayOf?: ReplayAttribution
}

/**
 * The projection of a {@link Run} that `run.json` actually holds — the meta file
 * carries no `messages`, `costInfo`, `stopReason` or `result`, only a `messageCount`.
 *
 * Named separately from `Run` rather than reusing it because a reader that types the
 * file as a `Run` gets a `messages: Message[]` field the file does not have, and the
 * first consumer to trust it reads `undefined.length`. The narrower type is the honest
 * one: it says what is on disk.
 */
export interface PersistedRunMeta {
	id: RunId
	status: AgentStatus
	metadata: RunStateMetadata
	tokenUsage: TokenUsage
	currentIteration: number
	startedAt: number
	endedAt?: number
	lastError?: string
	messageCount: number
	parentRunId?: RunId
	depth?: number

	/**
	 * The decision an `awaiting_input` run is parked on. This is what lets a process
	 * that did not park the run — a cancel, an operator tool, the next resume — find the
	 * checkpoint the decision lives on without scanning every checkpoint the run wrote.
	 */
	awaitingDecision?: AwaitingDecisionRef
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
