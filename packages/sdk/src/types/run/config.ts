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

	/**
	 * Extended-thinking request, forwarded on every model call in the run.
	 *
	 * Drivers that do not support it ignore the field. Note that a provider
	 * rejects temperature/top_p/top_k while thinking is enabled, so the
	 * driver omits them rather than sending a request it knows will 400.
	 */
	thinking?: import('../provider/index.js').ThinkingConfig
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

	/**
	 * How long a human-in-the-loop park stays worth serving, in ms.
	 *
	 * Written onto the park as an ABSOLUTE deadline, so it survives the
	 * process that set it. Every timer in the SDK is an in-process
	 * `setTimeout` and the park-record delay is deliberately `unref`'d, so
	 * nothing in memory can outlive a redeploy: without this a run parks for
	 * approval, the worker is replaced, nobody answers, and the checkpoint
	 * stays outstanding forever — every approval-queue reader keeps serving
	 * it and its workspace is never reclaimed.
	 *
	 * The run timeout does not cover this. It is only checked between
	 * iterations and a park suspends mid-iteration, so a long-lived process
	 * hard-stops the run immediately *after* the human finally approves,
	 * while across a restart the restored elapsed clock excludes parked time
	 * entirely — the same configuration producing two opposite outcomes.
	 *
	 * Expiry is enforced on READ (`findPendingCheckpoint` skips an expired
	 * park) and by a host sweep (`listExpiredParks` + `CheckpointManager
	 * .expire`). An out-of-process timer stays a host concern, consistent
	 * with the same decision made for retention.
	 *
	 * Default `undefined` — no deadline, today's behaviour.
	 */
	hitlParkTtlMs?: number
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
