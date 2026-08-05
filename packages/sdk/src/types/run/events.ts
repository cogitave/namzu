import type { ActivityStatus, ActivityType } from '../activity/index.js'
import type { BaseAgentResult } from '../agent/base.js'
import type { CostInfo, PlatformError, TokenUsage } from '../common/index.js'
import type { CheckpointId, ToolCallSummary } from '../hitl/index.js'
import type {
	ActivityId,
	MessageId,
	PlanId,
	PluginId,
	RunId,
	SandboxId,
	TaskId,
	ToolUseId,
} from '../ids/index.js'
import type { PlanStep } from '../plan/index.js'
import type { PluginHookEvent, PluginHookResult } from '../plugin/index.js'
import type { TaskStatus } from '../task/index.js'
import type { Lineage } from './lineage.js'
import type { MessageStopReason, StopReason } from './stop-reason.js'
import type {
	SubsessionIdledEvent,
	SubsessionMessagedEvent,
	SubsessionSpawnedEvent,
} from './subsession-events.js'

export type { MessageStopReason, StopReason } from './stop-reason.js'

/**
 * Additive envelope fields present on every {@link RunEvent} variant.
 *
 * Per session-hierarchy.md §10.1 evolution is additive and consumers filter
 * by the `type` discriminator, never by field shape. 0.2.0+ emitters stamp
 * `schemaVersion: 2`; older untagged events are treated as virtually v1 by
 * readers. `lineage` is populated on sub-session emissions (§10.4) and left
 * absent on root-session events.
 */
interface RunEventEnvelope {
	/**
	 * v3 envelope (ses_001-tool-stream-events, 2026-05-01). Removes
	 * `llm_response`; adds message + tool-input lifecycle variants;
	 * tightens `tool_executing` / `tool_completed` payloads. Emitters
	 * stamp this from {@link RUN_EVENT_SCHEMA_VERSION}.
	 */
	schemaVersion?: 3
	lineage?: Lineage
}

type CoreRunEvent =
	| { type: 'run_started'; runId: RunId; systemPrompt?: string }
	| { type: 'iteration_started'; runId: RunId; iteration: number }
	| {
			type: 'iteration_completed'
			runId: RunId
			iteration: number
			hasToolCalls: boolean
	  }
	/**
	 * A compaction pass replaced a span of history with a summary.
	 *
	 * Compaction deletes messages irrecoverably and previously emitted
	 * nothing at all — a host could not show the user that context was
	 * dropped, and `transcript.jsonl` recorded a conversation that silently
	 * lost its middle. Every field here is measured, not estimated, where
	 * the provider reported it (`measuredBy`).
	 */
	| {
			type: 'compaction_completed'
			runId: RunId
			iteration: number
			/** Messages before and after the pass. */
			messagesBefore: number
			messagesAfter: number
			/** Context size in tokens before and after. */
			tokensBefore: number
			tokensAfter: number
			/** Whether `tokensBefore` came from the provider or a heuristic. */
			measuredBy: 'provider' | 'estimate'
			/** The window the trigger measured against, and where it came from. */
			contextWindowTokens: number
			windowSource: 'config' | 'model-table' | 'default'
			/**
			 * False when the pass could not get the context below
			 * `resetThreshold` — the trigger is still armed, and a host may
			 * want to surface that the run is running tight.
			 */
			reachedResetThreshold?: boolean
	  }
	/**
	 * A compaction pass ran and shed nothing, so the history is unchanged.
	 *
	 * A shed that did not happen is exactly as consequential as one that did,
	 * and until this existed only one of them was on the wire. The three
	 * decline paths all reached a log line — and a host that silences its
	 * logger, which every command-line entry point does, made a failed
	 * compaction invisible to the user, to the host AND to the model. The run
	 * then continued at full context toward a provider rejection several turns
	 * later that named none of this.
	 *
	 * The history is guaranteed untouched on every one of these: the reducer's
	 * result is installed whole or not at all, so there is no partial state to
	 * reason about. That is the property that makes reporting sufficient and a
	 * repair unnecessary.
	 */
	| {
			type: 'compaction_failed'
			runId: RunId
			iteration: number
			/**
			 * Which decline path was taken. These want different responses, so
			 * a single "it failed" would put the reader back where the silence
			 * did:
			 *
			 * - `reducer_threw` — the reducer raised. Usually a bug or a failed
			 *   model call inside a summarising reducer; the next pass may work.
			 * - `shed_nothing` — it returned no fewer messages than it was
			 *   given. The history is already at its floor, or the reducer's
			 *   own threshold disagrees with the trigger's, and every later
			 *   pass will decline identically.
			 * - `split_tool_pair` — its result separated a `tool_use` from its
			 *   `tool_result`, so it was refused wholesale rather than sent to
			 *   a provider that rejects the pairing. A reducer bug, and one
			 *   `findSafeTrimIndex` exists to prevent.
			 */
			cause: 'reducer_threw' | 'shed_nothing' | 'split_tool_pair'
			/** Unchanged, and stated so a reader need not infer it. */
			messages: number
			/** Present only for `reducer_threw`. */
			error?: string
	  }
	| {
			type: 'tool_executing'
			runId: RunId
			toolUseId: ToolUseId
			toolName: string
			input: unknown
	  }
	/**
	 * A tool saying how far along it is.
	 *
	 * Ephemeral — excluded from `transcript.jsonl`, like `text_delta`. It is
	 * for a host rendering a live view, not part of the conversation, and a
	 * chatty tool must not be able to bloat the durable record.
	 *
	 * Tools get a deadline of up to two minutes by default, so before this
	 * a build, a test run or a long fetch was simply silent for its whole
	 * duration: the host could show that a tool had started and then nothing
	 * at all until it either finished or timed out. The model never sees
	 * these; they answer "is it still working?", which is a question only a
	 * human asks.
	 */
	| {
			type: 'tool_progress'
			runId: RunId
			toolUseId: ToolUseId
			toolName: string
			/** Human-readable, e.g. "compiled 40/120 files". */
			message: string
			/** Optional completion in [0,1] when the tool genuinely knows it. */
			fraction?: number
	  }
	/**
	 * A model call failed transiently and is being retried after a backoff.
	 *
	 * Answers the same question `tool_progress` answers — "is it still
	 * working?" — for the other half of a run's wall clock. With the default
	 * policy, or a server-directed delay up to the cap, a run can sit silent
	 * for the better part of a minute between `iteration_started` and the
	 * next event. A host saw literally nothing and no keepalive, so a
	 * backoff was indistinguishable from a hang and a watchdog would cancel
	 * a run that was about to succeed.
	 *
	 * Emitted before the sleep, so the delay it names is the one still
	 * ahead.
	 */
	| {
			type: 'provider_retry'
			runId: RunId
			iteration: number
			/** 1-based attempt that just failed. */
			attempt: number
			maxRetries: number
			delayMs: number
			/** Classified failure code, as the boundary classifier reports it. */
			code: string
			status?: number
			/** The delay came from the server's own `Retry-After`. */
			serverDirected: boolean
	  }
	| {
			type: 'tool_completed'
			runId: RunId
			toolUseId: ToolUseId
			toolName: string
			result: string
			isError: boolean
			/**
			 * Wall-clock the tool took. Computed since the first version of
			 * the executor but only ever logged; a host asking "which tool
			 * was slow" had to reconstruct it from event timestamps.
			 */
			durationMs?: number
			/**
			 * Size of the tool's output BEFORE the model-visible budget was
			 * applied, so a host can report "returned 2.1 MB" even though
			 * `result` is a preview.
			 */
			outputLength?: number
			/** True when `result` is a preview rather than the whole output. */
			outputTruncated?: boolean
			/** Where the full output was written, when it was spilled. */
			outputSpillPath?: string
	  }
	/**
	 * A tool asked the user a question and the run is parked on it.
	 *
	 * The question used to park through the raw handler under a synthetic
	 * checkpoint id that was never written, so a remote host could not
	 * observe it at all — the in-process callback was the only channel, and
	 * a tool review with the same shape had an event, a bridge mapping and
	 * a durable record. This is that surface, for the other kind of park.
	 */
	| {
			type: 'user_question_asked'
			runId: RunId
			checkpointId: CheckpointId
			/** The asking `tool_use_id`, so an answer can be matched back. */
			questionId: string
			question: string
	  }
	/**
	 * The question was resolved.
	 *
	 * `answered: false` covers a decline and a non-response. Distinguished
	 * because the asking tool refuses to invent consent from either, and a
	 * host rendering the card needs the same distinction.
	 */
	| {
			type: 'user_question_answered'
			runId: RunId
			checkpointId: CheckpointId
			/**
			 * Which question, when the resolution named one.
			 *
			 * Its sibling `user_question_asked` carries this and the answer
			 * did not, so a client that keyed on the question id — the
			 * natural key, since it is what routes an answer back on resume
			 * — could not match the two halves without also having stored
			 * the checkpoint id. Absent when the pause was resolved without
			 * an answer.
			 */
			questionId?: string
			answered: boolean
	  }
	| {
			type: 'tool_review_requested'
			runId: RunId
			toolCalls: ToolCallSummary[]
			iteration: number
	  }
	| {
			type: 'tool_review_completed'
			runId: RunId
			decision: 'approved' | 'modified' | 'rejected'
	  }
	| {
			type: 'checkpoint_created'
			runId: RunId
			checkpointId: CheckpointId
			iteration: number
	  }
	| {
			type: 'run_paused'
			runId: RunId
			checkpointId: CheckpointId
			reason: string
	  }
	| {
			type: 'run_resuming'
			runId: RunId
			fromCheckpointId: CheckpointId
	  }
	/**
	 * A guardrail blocked or rewrote the run.
	 *
	 * Emitted so a host can show WHY a run refused, and — for a rewrite —
	 * so a consumer that already rendered `text_delta` events knows the
	 * text it displayed has been corrected.
	 */
	| {
			type: 'guardrail_triggered'
			runId: RunId
			stage: 'input' | 'output'
			action: 'block' | 'rewrite'
			guardrail?: string
			reason?: string
	  }
	/**
	 * The run reached its end without throwing.
	 *
	 * `completed` is not `succeeded`. A run stopped by its token budget, its
	 * timeout, its iteration cap, a cancellation or a blocking output guardrail
	 * all arrive here — `run_failed` is emitted only from the throw path — so a
	 * consumer that treated this event as success reported one for a run whose
	 * answer was refused. Measured: `max_iterations` produces
	 * `status: 'completed'` with `result` holding whatever partial text existed.
	 *
	 * `stopReason` is what separates them, and it is on the event because the
	 * alternative is asking every consumer to hold the `Run` as well.
	 */
	| { type: 'run_completed'; runId: RunId; result: string; stopReason?: StopReason }
	/**
	 * The run failed.
	 *
	 * `error` is the flattened message, kept for every consumer that only
	 * ever rendered a string. `failure` is the structured projection, and
	 * it is the point: namzu already classifies at the provider boundary —
	 * over status, errno, `Retry-After` and the whole cause chain — so a
	 * fully-populated error genuinely arrived here and was flattened one
	 * line later, discarding `code`, `status`, `retryAfterMs`, `retryable`
	 * and `details`.
	 *
	 * The damage was self-inflicted downstream: one consumer substring-
	 * matched the flattened message to decide whether an error had
	 * occurred, and the iteration loop re-ran the classifier to recover
	 * structure that had already been computed upstream.
	 */
	| {
			type: 'run_failed'
			runId: RunId
			error: string
			failure?: PlatformError
			/**
			 * The driver's own classification, when it produced one. Carried
			 * beside `failure` rather than folded into it: this is the
			 * provider's first-hand statement, and a consumer deciding whether
			 * to retry reads it directly.
			 */
			providerError?: import('../provider/error.js').ProviderErrorInfo
			/**
			 * Operator-facing explanation, when a catalog rule claims this
			 * failure: a stable `id` to grep for, and `hint` saying what to
			 * change. Absent when no rule matched — inventing advice for an
			 * uncharacterised failure is worse than saying nothing, because
			 * it sends the reader somewhere specific and wrong.
			 */
			explanation?: { id: string; message: string; hint: string }
	  }
	// Additive 2026-07 (provider capability negotiation): emitted once per
	// run when the request asks for something the provider DRIVER declared
	// it cannot do — tools registered against a no-tools driver (tool
	// surfaces stripped so the model is never told about uncallable
	// tools), or image attachments against a no-vision driver (attachments
	// dropped). Hosts surface these so degradation is visible, not silent.
	| {
			type: 'capability_warning'
			runId: RunId
			capability: 'tools' | 'vision'
			providerId: string
			message: string
	  }
	| {
			type: 'token_usage_updated'
			runId: RunId
			usage: TokenUsage
			cost: CostInfo
			/**
			 * How large the CONTEXT is right now, and how large it may get.
			 *
			 * These are a different quantity from `usage` beside them and the
			 * distinction is the whole reason they are named this explicitly.
			 * `usage` is CUMULATIVE SPEND over the run: prompt plus completion
			 * tokens summed across every turn, monotonically increasing, and
			 * untouched by compaction. `contextTokens` is the size of the
			 * conversation being sent right now, which falls when a compaction
			 * sheds.
			 *
			 * Dividing the first by a context window is a category error, and
			 * it is one this estate shipped: a host did exactly that, so its
			 * indicator climbed toward full on any long run no matter how much
			 * room the conversation actually had — most wrong precisely when
			 * someone needed it most. The numbers are here so nobody has to
			 * reach for the wrong one, and named so reaching for it is a
			 * visible mistake rather than a plausible guess.
			 *
			 * `contextMeasuredBy` says whether the provider counted the prompt
			 * or we estimated it, and `windowSource` where the ceiling came
			 * from. A fraction of two numbers is only as honest as the weaker
			 * of them, and a surface rendering these owes a reader the same
			 * distinction rather than presenting an estimate as a measurement.
			 *
			 * Absent when the run has no compaction configuration, because
			 * nothing then resolves a window and inventing one would be the
			 * guess this exists to replace.
			 */
			contextTokens?: number
			contextMeasuredBy?: 'provider' | 'estimate'
			contextWindowTokens?: number
			windowSource?: 'config' | 'model-table' | 'default'
	  }
	| {
			type: 'activity_created'
			runId: RunId
			activityId: ActivityId
			activityType: ActivityType
			description: string
	  }
	| {
			type: 'activity_updated'
			runId: RunId
			activityId: ActivityId
			status: ActivityStatus
			output?: unknown
			error?: string
	  }
	| {
			type: 'plan_ready'
			runId: RunId
			planId: PlanId
			title: string
			steps: PlanStep[]
			summary?: string
	  }
	| { type: 'plan_approved'; runId: RunId; planId: PlanId }
	| {
			type: 'plan_rejected'
			runId: RunId
			planId: PlanId
			reason?: string
	  }
	| {
			type: 'plan_step_updated'
			runId: RunId
			planId: PlanId
			stepId: string
			status: PlanStep['status']
	  }
	| {
			type: 'agent_pending'
			runId: RunId
			taskId: TaskId
			parentAgentId: string
			childAgentId: string
			depth: number
	  }
	| {
			type: 'agent_completed'
			runId: RunId
			taskId: TaskId
			result: BaseAgentResult
	  }
	| {
			type: 'agent_failed'
			runId: RunId
			taskId: TaskId
			error: string
	  }
	| { type: 'agent_canceled'; runId: RunId; taskId: TaskId }
	| {
			type: 'task_created'
			runId: RunId
			taskId: TaskId
			subject: string
			status: TaskStatus
	  }
	| {
			type: 'task_updated'
			runId: RunId
			taskId: TaskId
			subject: string
			status: TaskStatus
			owner?: string
	  }
	| {
			type: 'plugin_hook_executing'
			runId: RunId
			pluginId: PluginId
			hookEvent: PluginHookEvent
	  }
	| {
			type: 'plugin_hook_completed'
			runId: RunId
			pluginId: PluginId
			hookEvent: PluginHookEvent
			result: PluginHookResult
	  }
	| {
			type: 'sandbox_created'
			runId: RunId
			sandboxId: SandboxId
			environment: string
	  }
	| {
			type: 'sandbox_exec'
			runId: RunId
			sandboxId: SandboxId
			command: string
			exitCode: number
			durationMs: number
	  }
	| { type: 'sandbox_destroyed'; runId: RunId; sandboxId: SandboxId }
	// ─────────────────────────────────────────────────────────────────────
	// v3 message + tool-input lifecycle (additive 2026-05; see
	// ses_001-tool-stream-events). These are not yet emitted by the
	// iteration orchestrator — phase 4 of the migration switches the
	// orchestrator to streaming consumption and removes `llm_response`.
	// Until then these variants exist so consumers can be wired ahead of
	// the producer-side cutover.
	// ─────────────────────────────────────────────────────────────────────
	| {
			type: 'message_started'
			runId: RunId
			iteration: number
			messageId: MessageId
	  }
	/**
	 * The model began emitting a reasoning block.
	 *
	 * Without these, extended thinking looked to a streaming UI like a
	 * multi-second stall with no events at all — the run was working, and
	 * the host had no way to say so.
	 */
	| {
			type: 'reasoning_started'
			runId: RunId
			iteration: number
			messageId: MessageId
			blockIndex: number
			reasoningType: 'thinking' | 'redacted_thinking'
	  }
	/** Ephemeral — excluded from `transcript.jsonl`, like `text_delta`. */
	| {
			type: 'reasoning_delta'
			runId: RunId
			iteration: number
			messageId: MessageId
			blockIndex: number
			text: string
	  }
	| {
			type: 'reasoning_completed'
			runId: RunId
			iteration: number
			messageId: MessageId
			blockIndex: number
			/** Present only when the provider returned readable thinking. */
			text?: string
			/** True when the block carried a signature that must be replayed. */
			signed: boolean
	  }
	| {
			type: 'text_delta'
			runId: RunId
			iteration: number
			messageId: MessageId
			text: string
	  }
	| {
			type: 'message_completed'
			runId: RunId
			iteration: number
			messageId: MessageId
			stopReason: MessageStopReason
			usage?: TokenUsage
			/**
			 * Aggregated assistant text accumulated from `text_delta`
			 * events for this message. Optional so consumers that
			 * already concatenate deltas themselves don't have to pay
			 * the duplication; consumers that only care about the
			 * completed message (telemetry, A2A bridge, postmortem
			 * tooling) can read this field directly.
			 */
			content?: string
	  }
	| {
			type: 'tool_input_started'
			runId: RunId
			iteration: number
			messageId: MessageId
			toolUseId: ToolUseId
			toolName: string
	  }
	| {
			type: 'tool_input_delta'
			runId: RunId
			toolUseId: ToolUseId
			partialJson: string
	  }
	| {
			type: 'tool_input_completed'
			runId: RunId
			toolUseId: ToolUseId
			input: unknown
			/**
			 * True when the provider stream ended before the tool JSON
			 * arguments closed. `input` stays a sanitized object so public
			 * consumers never receive internal recovery sentinels.
			 */
			inputTruncated?: boolean
	  }

/**
 * Discriminated union of all run-scoped events emitted by the kernel.
 *
 * Convention #16: `type` is the sole discriminator for exhaustive switches;
 * envelope fields (`schemaVersion`, `lineage`) are additive and never
 * participate in discrimination. Sub-session lifecycle variants
 * (`subsession_spawned`, `subsession_messaged`, `subsession_idled`) carry a
 * required `lineage` — see session-hierarchy.md §10.4.
 */
export type RunEvent =
	| (CoreRunEvent & RunEventEnvelope)
	| SubsessionSpawnedEvent
	| SubsessionMessagedEvent
	| SubsessionIdledEvent

export type RunEventListener = (event: RunEvent) => void | Promise<void>

/**
 * Event types whose volume makes durable persistence wasteful.
 *
 * `text_delta` and `tool_input_delta` arrive at provider cadence (often
 * 50–100 events per second), carry no information not derivable from the
 * surrounding message/tool lifecycle events, and are not consulted by
 * replay (`runtime/query/replay/prepare.ts` reads checkpoints, not the
 * transcript). The kernel still dispatches them on the in-memory bus so
 * SSE consumers can render live progress, but the disk store
 * (`store/run/disk.ts:appendEvent`) skips them via this predicate.
 *
 * Keeping the predicate centralised — rather than threading an
 * `ephemeral: true` field through every emit site — means new ephemeral
 * variants are added by editing one Set and consumers don't have to
 * inspect event shape to decide what to persist.
 */
const EPHEMERAL_EVENT_TYPES: ReadonlySet<RunEvent['type']> = new Set<RunEvent['type']>([
	'text_delta',
	'tool_input_delta',
	// The completed block carries the full text; the deltas would only
	// duplicate it into the transcript at scale.
	'reasoning_delta',
	// Answers "is it still working?", which only a live view asks. A tool
	// reporting every file it compiles must not be able to write thousands
	// of lines into the durable record.
	'tool_progress',
])

export function isEphemeralEvent(event: RunEvent): boolean {
	return EPHEMERAL_EVENT_TYPES.has(event.type)
}
