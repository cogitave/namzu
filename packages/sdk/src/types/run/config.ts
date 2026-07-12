import type { ModelPricing } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { ProjectId, ThreadId } from '../session/ids.js'
import type { ReplayAttribution } from './replay.js'

/**
 * Retry / reactive-recovery policy for the runtime loop's model calls. Fully
 * resolved (every field required) — the possibly-partial surface lives on the
 * Zod `RetryConfigSchema` in `config/runtime.ts`; `resolveRetryConfig` fills
 * defaults for callers that omit `retry` entirely.
 */
export interface RetryConfig {
	/** Master switch. When false the model call is attempted exactly once. */
	enabled: boolean
	/** Max physical attempts for a single logical model call (includes the first). */
	maxAttempts: number
	/** Base delay for full-jitter exponential backoff, in milliseconds. */
	baseDelayMs: number
	/** Ceiling for any single computed backoff wait, in milliseconds. */
	maxDelayMs: number
	/** Max reactive context-overflow reduce+reissue passes per iteration. */
	overflowAttempts: number
}

export interface AgentRunConfig {
	model: string
	timeoutMs: number
	maxResponseTokens?: number
	tokenBudget: number
	costLimitUsd?: number
	maxIterations?: number
	temperature?: number
	env?: Record<string, string>
	permissionMode?: PermissionMode
	retry?: RetryConfig
	sandbox?: {
		timeoutMs?: number
		memoryLimitMb?: number
		maxProcesses?: number
	}
}

/**
 * Config for {@link RunPersistence}. `sessionId`, `threadId`, `tenantId`,
 * and `projectId` are required — every Run is attributed across the full
 * five-layer scope (Tenant → Project → Thread → Session → Run,
 * Convention #17).
 */
export interface RunPersistenceConfig {
	runId: RunId
	agentId: string
	agentName: string
	runConfig: AgentRunConfig
	providerId: string
	outputDir: string
	pricing?: ModelPricing
	log: Logger

	sessionId: SessionId
	threadId: ThreadId
	tenantId: TenantId
	projectId: ProjectId

	parentRunId?: RunId

	depth?: number

	/**
	 * Provenance of a FORKED run — the source run and the checkpoint it was forked at.
	 * Persisted onto the fork's own `run.json`, because the source's record says nothing
	 * about it: a fork must not touch its source. See {@link
	 * import('../../runtime/query/replay/fork.js').prepareForkState}.
	 */
	replayOf?: ReplayAttribution
}

export interface RunStoreConfig {
	baseDir: string
	logger?: Logger
}

export interface LimitCheckerConfig {
	tokenBudget: number
	timeoutMs: number
	costLimitUsd?: number
	maxIterations: number
	budgetWarningThreshold: number
}
