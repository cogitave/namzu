import type { ModelPricing } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import type { RunId, SessionId, TenantId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { ProjectId, ThreadId } from '../session/ids.js'
import type { CheckpointStore } from './checkpoint-store.js'

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
	sandbox?: {
		timeoutMs?: number
		memoryLimitMb?: number
		maxProcesses?: number
	}

	/**
	 * Iteration-checkpoint cadence: create a checkpoint on every Nth
	 * tool-call iteration (iterations 1, 1+N, 1+2N, …). Default `1` —
	 * a checkpoint per iteration, today's behavior. Values < 1 are
	 * treated as 1. Off-cadence iterations also skip the HITL
	 * `iteration_checkpoint` park (there is no checkpoint id to park on).
	 * Tool-review and plan-approval checkpoints are unaffected — those
	 * exist to anchor a pending HITL decision, not for growth control.
	 */
	checkpointEvery?: number

	/**
	 * After creating an iteration checkpoint, prune the run's checkpoint
	 * set down to the newest N (oldest-first deletion across ALL of the
	 * run's checkpoints, including tool-review/plan ones). Default
	 * `undefined` — never prune, today's behavior. Each checkpoint copies
	 * the full message array, so long tool-heavy runs grow O(iterations ×
	 * history) without this.
	 */
	pruneKeepLast?: number
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
	 * Optional checkpoint persistence override. Defaults to the disk
	 * layout under `outputDir` (a
	 * {@link import('../../store/run/checkpoint-disk.js').DiskCheckpointStore});
	 * hosts inject a scope-keyed backend (e.g. Postgres) here.
	 */
	checkpointStore?: CheckpointStore
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
