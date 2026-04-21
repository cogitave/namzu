import type { AgentStatus, CostInfo, TokenUsage } from '../common/index.js'
import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { AgentRunConfig } from './config.js'
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
