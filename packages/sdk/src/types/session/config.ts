import type { SessionTokenBudget } from '../../store/budget/index.js'
import type { SessionCheckpointStore } from '../../store/checkpoint/index.js'
import type { SessionLog } from '../../store/session-log/index.js'
import type { ModelPricing } from '../../utils/cost.js'
import type { Logger } from '../../utils/logger.js'
import type { SessionId, TenantId, TurnId } from '../ids/index.js'
import type { PermissionMode } from '../permission/index.js'
import type { ProjectId, TopicId } from './ids.js'

/** The configuration one turn runs with. */
export interface TurnConfig {
	model: string
	/** Total turn duration in milliseconds; 0 disables the turn deadline. */
	timeoutMs: number
	/**
	 * Maximum silence between provider stream chunks, in milliseconds.
	 *
	 * Defaults to five minutes at the `query()` boundary. This is distinct
	 * from `timeoutMs`, which is checked between agent iterations and cannot
	 * settle a provider iterator whose pending `next()` never returns. Set
	 * `0` to retain unbounded stream silence. Positive values must be integer
	 * milliseconds accepted by the platform timer.
	 */
	streamIdleTimeoutMs?: number
	/**
	 * Maximum accumulated inline image/document payload on one provider request.
	 *
	 * Defaults to 24 MiB. The budget is shared by user attachments and rich
	 * tool-result blocks. When history exceeds it, the provider-bound projection
	 * replaces the oldest values with model-visible omission markers; the turn's
	 * canonical messages and durable evidence remain unchanged. Set `0` to keep
	 * the prior unbounded behaviour.
	 */
	maxRequestRichContentBytes?: number
	maxResponseTokens?: number

	/**
	 * Extended-thinking request, forwarded on every model call in the turn.
	 *
	 * Drivers that do not support it ignore the field. Note that a provider
	 * rejects temperature/top_p/top_k while thinking is enabled, so the
	 * driver omits them rather than sending a request it knows will 400.
	 */
	thinking?: import('../provider/index.js').ThinkingConfig

	/**
	 * How much work the model should spend on each call in the turn.
	 *
	 * A SIBLING of {@link TurnConfig.thinking}, not a field inside it.
	 * On some models the two are independent controls that apply together —
	 * effort shapes the answer while a budget sets thinking depth — so
	 * nesting one inside the other would make that combination unsayable.
	 *
	 * The failure this closes is the one this codebase keeps finding: the
	 * field existed on the provider params, a driver already read it and
	 * wrote it to the wire, and nothing in the kernel ever set it. So a
	 * caller could not reach it at all, and the symptom — every request
	 * going out at the model's default — reads as "this model ignores
	 * effort" rather than "nobody plumbed it through".
	 *
	 * Turn-level rather than per-step, deliberately. It is a property of what
	 * the turn is FOR, and a value that moves between steps buys a different
	 * answer shape at the cost of the prompt-cache prefix on every step that
	 * changes it.
	 *
	 * A driver that cannot honour it REFUSES rather than dropping it, on the
	 * same reasoning as `thinking`: paying for a turn you believe was
	 * high-effort and silently was not is worse than a startup error.
	 */
	effort?: import('../provider/index.js').ReasoningEffort
	/** Provider-hosted search for this turn. Explicit opt-in; no local network permission. */
	webSearch?: import('../provider/index.js').ChatCompletionParams['webSearch']
	/** Cumulative parent-and-descendant tokens; 0 is unlimited with usage accounting. */
	tokenBudget: number
	costLimitUsd?: number
	/** Main-loop iterations; 0 disables this guard. Omitted defaults depend on the entry point. */
	maxIterations?: number
	temperature?: number
	env?: Record<string, string>
	permissionMode?: PermissionMode
	sandbox?: {
		timeoutMs?: number
		memoryLimitMb?: number
		maxProcesses?: number
		/**
		 * What the sandbox is rooted at — see `SandboxConfigSchema.workspace`.
		 * Absent means `'ephemeral'`: a fresh temp directory, which is the
		 * behaviour every sandboxed run had before this existed.
		 */
		workspace?: 'ephemeral' | 'working-directory'
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
	 * After creating an iteration checkpoint, prune the turn's checkpoint
	 * set down to the newest N. Default `undefined` — never prune. A
	 * checkpoint holds no inline messages (its context is the fold of the
	 * session log through `throughSeq`), so it costs its own bookkeeping
	 * rather than a copy of the conversation, but the COUNT only ever grows
	 * unless a host bounds it here. The CLI does.
	 *
	 * Oldest-first by `createdAt`, across all of the turn's checkpoints — but
	 * a checkpoint an open decision references is never collected, whatever
	 * its age. Those rows are what `SessionIndex.listPendingDecisions` serves
	 * to an approval queue and what a sweep enumerates, so pruning
	 * briefly holds more than N while a park is outstanding; the next prune
	 * after the park resolves — by `unpark`, or by `expire` for one that ran
	 * out of time — collects them. A host that needs the bound to hold
	 * regardless should sweep expired parks itself.
	 */
	pruneKeepLast?: number

	/**
	 * How long a human-in-the-loop park stays worth serving, in ms.
	 *
	 * Written onto the park as an ABSOLUTE deadline, so it survives the
	 * process that set it. Every timer in the SDK is an in-process
	 * `setTimeout` and the park-record delay is deliberately `unref`'d, so
	 * nothing in memory can outlive a redeploy: without this a turn parks for
	 * approval, the worker is replaced, nobody answers, and the checkpoint
	 * stays outstanding forever — every approval-queue reader keeps serving
	 * it and its workspace is never reclaimed.
	 *
	 * The turn timeout does not cover this. It is only checked between
	 * iterations and a park suspends mid-iteration, so a long-lived process
	 * hard-stops the turn immediately *after* the human finally approves,
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

	/**
	 * Override the logger a turn's log lines derive from.
	 *
	 * This is an override of the SOURCE, not a substitute for correlation:
	 * `TurnContextFactory.buildLogger` always calls `.child()` on whichever
	 * logger this resolves to, so a host-supplied logger still gains
	 * `namzu.turn.id`, `sessionId`, `threadId`, `projectId` and `tenantId` —
	 * the same binding the process default gets. A host that wants its own
	 * sink, format or destination threaded through every record a turn
	 * produces sets this once; a host that wants the process default
	 * (`getRootLogger()`) sets nothing, which is what absent has always
	 * meant.
	 */
	logger?: Logger
}

/**
 * Config for {@link import('../../manager/session/turn-recorder.js').TurnRecorder}.
 *
 * `sessionId`, `topicId`, `tenantId` and `projectId` are required: every
 * turn is attributed across the full scope (Tenant → Project → Topic →
 * Session → Turn). The recorder appends records to `sessionLog` under the
 * session lease; it writes no `run.json`, `messages.json` or `report.md`.
 */
export interface TurnRecorderConfig {
	/** The ledger this turn and its child sessions spend from, keyed by (rootSessionId, rootTurnId). */
	budget?: SessionTokenBudget
	sessionId: SessionId
	turnId: TurnId
	agentId: string
	agentName: string
	turnConfig: TurnConfig
	providerId: string
	pricing?: ModelPricing
	log: Logger

	topicId: TopicId
	tenantId: TenantId
	projectId: ProjectId

	/** Present on a child session's turn: the parent session that delegated it. */
	parentSessionId?: SessionId
	/** Present on a child session's turn: the parent turn whose tool call spawned the child. */
	parentTurnId?: TurnId

	depth?: number

	/** The session log the turn's records are appended to. */
	sessionLog: SessionLog

	/**
	 * Optional checkpoint persistence override. Defaults to the disk layout
	 * under `<session-id>/checkpoints/`; hosts inject a scope-keyed backend here.
	 */
	checkpointStore?: SessionCheckpointStore
}

export interface LimitCheckerConfig {
	tokenBudget: number
	timeoutMs: number
	costLimitUsd?: number
	maxIterations: number
	budgetWarningThreshold: number
}
