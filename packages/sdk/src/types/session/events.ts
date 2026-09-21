import type { TokenBudgetSummary } from '../../run/token-budget.js'
import type { ActivityStatus, ActivityType } from '../activity/index.js'
import type { BaseAgentResult } from '../agent/base.js'
import type { CostInfo, PlatformError, TokenUsage } from '../common/index.js'
import type { CheckpointId, ToolCallSummary } from '../hitl/index.js'
import type {
	ActivityId,
	MessageId,
	PlanId,
	PluginId,
	SandboxId,
	SessionId,
	TaskId,
	ToolUseId,
	TurnId,
} from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { PlanStep } from '../plan/index.js'
import type { PluginHookEvent, PluginHookResult } from '../plugin/index.js'
// Unchanged names that still live in the run type directory until the cutover
// moves them here: the cancellation cause, the stop reasons, the lease
// fence and the delegation lineage.
import type { CancelCause } from '../run/cancel-cause.js'
import type { FencingToken } from '../run/checkpoint-store.js'
import type { Lineage } from '../run/lineage.js'
import type { MessageStopReason, StopReason } from '../run/stop-reason.js'
import type { TaskStatus } from '../task/index.js'
import type { ToolResultView } from '../tool/presentation.js'
import type { SubSessionKind } from './sub-session.js'
import type { Origin, TurnBudgetBinding, TurnConfigSnapshot, TurnSettlement } from './turn.js'

/**
 * Live events of a session: the stream a host listens to while a turn runs.
 *
 * The model is session → turn → message. Every event names the session it
 * belongs to (`sessionId`) and, when it happened inside a turn, the turn
 * (`turnId`). Events that can only happen inside a turn declare `turnId`
 * required; the ones a host can cause between turns (a manual compaction, a
 * background job exiting, a policy swap, a session hook, task and sandbox
 * bookkeeping) declare it optional, and an absent `turnId` means "outside any
 * turn".
 *
 * Every event whose type {@link isEphemeralEvent} does not name is also
 * appended to the session log as a record of the same `type`, with its
 * payload minus `sessionId`, `turnId` and `lineage` (those live on the record
 * envelope, or follow from `session_started.parent`). The record schema is in
 * `./records.ts` and `docs/sdk/session-log.md`.
 */
export interface SessionEventEnvelope {
	/** Session record schema version; see `SESSION_RECORD_SCHEMA_VERSION`. */
	v?: 1
	/**
	 * Delegation linkage, present on events relayed from a child session to a
	 * listener of its parent. `depth` is 0 at the root session.
	 */
	lineage?: Lineage
	/**
	 * This event's position in its session's log, from 1.
	 *
	 * Present means recorded: the writer appends the record first and only then
	 * hands the event to the live stream, so a `seq` a consumer sees is one the
	 * log contains, and it works as a reconnect cursor. Absent means not
	 * recoverable: an ephemeral event, an event whose append failed (still
	 * delivered, because losing the news of a failure is worse than delivering
	 * it without a cursor), or an event relayed from a child session, whose
	 * position is in the child's own log.
	 *
	 * Per session, not per stream: a listener that also receives child events
	 * keeps one cursor per `sessionId`.
	 */
	seq?: number
	/**
	 * The lease fence the session log was written under (the record's `gen`).
	 * A takeover raises it, which makes a cursor from before the takeover
	 * detectable rather than silently wrong.
	 */
	generation?: FencingToken
}

type CoreSessionEvent =
	| {
			type: 'tool_calls_admitted'
			sessionId: SessionId
			turnId: TurnId
			kind: 'initialize' | 'batch' | 'nested' | 'retry'
			/** Newly reserved attempts; zero only for ledger initialization. */
			count: number
			/** Cumulative reserved attempts, including abandoned reservations. */
			used: number
			limit: number
	  }
	/**
	 * A turn began. The prompt that opened it is the `message` record named by
	 * `userMessageId`, appended right after this one and inside the turn.
	 */
	| {
			type: 'turn_started'
			sessionId: SessionId
			turnId: TurnId
			userMessageId: MessageId
			systemPrompt?: string
			config: TurnConfigSnapshot
			/** Which protocol and which caller-side ids opened the turn. */
			origin?: Origin
			/** The token ledger this turn spends from, keyed by the root turn. */
			budget?: TurnBudgetBinding
	  }
	| { type: 'iteration_started'; sessionId: SessionId; turnId: TurnId; iteration: number }
	/**
	 * Who answers when this turn asks a human, changed mid-turn.
	 *
	 * The policy used to be a closure captured at `query()` start, so
	 * changing it meant ending the turn. Now it is a value a host can swap —
	 * and a swap that left no trace would be the worst version of that: an
	 * incident review would see approvals with no way to tell which rule
	 * granted them.
	 *
	 * Names, not handlers. A durable log cannot hold a function, and
	 * `[Function (anonymous)]` is what a log says when somebody tries.
	 */
	| {
			type: 'approval_policy_changed'
			sessionId: SessionId
			turnId?: TurnId
			from: string
			to: string
			reason: string
	  }
	/**
	 * What the model was actually asked, when it changed.
	 *
	 * `turn_started` records a system prompt once, and tool schemas never
	 * reached the transcript at all — yet the effective envelope changes
	 * mid-turn: `prepareStep` rewrites the system text, narrows the tool
	 * list, or swaps the model, and a step's skills ride an ephemeral
	 * trailing system message. So a transcript showed one prompt and a turn
	 * that had asked several different questions.
	 *
	 * Emitted only when the tuple DIFFERS from the last one recorded. The
	 * common case — nothing changed — costs one hash and no event, because
	 * a per-iteration copy of an unchanged system prompt is the fastest way
	 * to make a durable log too large to read.
	 */
	| {
			type: 'request_envelope'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			model: string
			/** Leading system messages plus this step's preamble, concatenated. */
			systemPrompt: string
			toolNames: readonly string[]
			/**
			 * Stable hash over the sorted tool schemas. A name list cannot see
			 * a tool whose SCHEMA changed while its name did not — which is
			 * the change most likely to alter what the model does and least
			 * likely to be noticed.
			 */
			toolSchemaDigest: string
	  }
	| {
			type: 'iteration_completed'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			hasToolCalls: boolean
	  }
	/**
	 * What a compaction pass removed, recorded before it is gone.
	 *
	 * Emitted BEFORE the context is replaced, and appended to the session log
	 * with the pass's `compaction` record, so the shed messages stay in the log
	 * for audit, search and undo even though the next request no longer
	 * carries them. The fold that builds the context reads the `compaction`
	 * record (its summary and kept message ids), not this event.
	 *
	 * Carries whole message bodies, tool output included, which is why both
	 * external wire mappers decline it.
	 */
	| {
			type: 'compaction_shed'
			sessionId: SessionId
			turnId?: TurnId
			iteration: number
			/** Exactly the messages the pass removed, in their original order. */
			messages: Message[]
			/** Automatic threshold, provider rejection, or a host-requested pass. */
			reason: 'threshold' | 'overflow' | 'manual'
	  }
	| {
			type: 'compaction_completed'
			sessionId: SessionId
			turnId?: TurnId
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
			windowSource: 'config' | 'provider' | 'model-table' | 'default'
			/**
			 * False when the pass could not get the context below
			 * `resetThreshold` — the trigger is still armed, and a host may
			 * want to surface that the turn is running tight.
			 */
			reachedResetThreshold?: boolean
	  }
	/**
	 * Oversized tool results were emptied instead of the history being
	 * summarized.
	 *
	 * This is the most common context-relief path and it was the only one
	 * that emitted nothing. It edits the conversation the model sees —
	 * `tool_result` bodies are replaced, irrecoverably — so a host reading
	 * the session log saw results it no longer has and no record of why.
	 * The two summarization outcomes were both on the wire; the cheap one
	 * that runs far more often was not.
	 *
	 * Emitted on BOTH branches. `reliefWasEnough: false` means the clear
	 * happened and was insufficient, so a full summarization followed and a
	 * `compaction_completed` is coming — the history took two edits, not
	 * one, and a reader that only saw the second would misattribute the
	 * first.
	 */
	| {
			type: 'compaction_tool_results_cleared'
			sessionId: SessionId
			turnId?: TurnId
			iteration: number
			/** How many `tool_result` bodies were emptied. */
			clearedCount: number
			/** Assistant narrations cut to their first sentence by the salience pass, when it ran. */
			stubbedCount?: number
			/** Characters removed, summed across those results. */
			charsReclaimed: number
			/** `charsReclaimed` as tokens, by the same estimate the trigger uses. */
			reclaimedTokens: number
			/**
			 * Whether the clear alone brought the context back under
			 * `triggerThreshold`. `false` means summarization ran afterwards.
			 */
			reliefWasEnough: boolean
	  }
	/**
	 * A compaction pass ran and shed nothing, so the history is unchanged.
	 *
	 * A shed that did not happen is exactly as consequential as one that did,
	 * and until this existed only one of them was on the wire. The three
	 * decline paths all reached a log line — and a host that silences its
	 * logger, which every command-line entry point does, made a failed
	 * compaction invisible to the user, to the host AND to the model. The turn
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
			sessionId: SessionId
			turnId?: TurnId
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
			sessionId: SessionId
			turnId: TurnId
			toolUseId: ToolUseId
			toolName: string
			input: unknown
			/**
			 * Present when another TOOL dispatched this call, rather than the
			 * model.
			 *
			 * `run_code` is the reason: a program it runs calls tools in a
			 * loop, and those calls went through `registry.execute` directly —
			 * so they reached the permission gate and reached the event stream
			 * not at all. A turn whose transcript showed one `run_code` call and
			 * nothing about the eleven writes it performed is a transcript
			 * that cannot be audited.
			 *
			 * Named rather than merely present, and this is the load-bearing
			 * part: without it a consumer counting tool calls double-counts —
			 * the parent AND each child — and a consumer rendering a timeline
			 * draws eleven siblings where there is one call with eleven
			 * children.
			 */
			via?: {
				readonly tool: string
				readonly toolUseId: ToolUseId
				/** The code runtime's request id, when that was the dispatch source. */
				readonly runtimeToolCallId?: string
			}
	  }
	/**
	 * A tool saying how far along it is.
	 *
	 * Ephemeral — never appended to the session log, like `text_delta`. It is
	 * for a host rendering a live view, not part of the conversation, and a
	 * chatty tool must not be able to bloat the durable record.
	 *
	 * Tools get a deadline of up to two minutes by default, so before this
	 * a build, a test run or a long fetch was simply silent for its whole
	 * duration: the host could show that a tool had started and then nothing
	 * at all until it either finished or timed out. The model never sees
	 * these; they answer "is it still working?", which is a question only a
	 * human asks. It is latest state rather than a lossless log: the executor
	 * bounds each UTF-8 message and coalesces intermediate updates when the
	 * live consumer falls behind. Complete output belongs to the terminal
	 * `tool_completed` result.
	 */
	| {
			type: 'tool_progress'
			sessionId: SessionId
			turnId: TurnId
			toolUseId: ToolUseId
			toolName: string
			/** Human-readable, e.g. "compiled 40/120 files". */
			message: string
			/** Optional completion in [0,1] when the tool genuinely knows it. */
			fraction?: number
	  }
	/** Provider-executed activity, retained as evidence rather than a local tool request. */
	| {
			type: 'hosted_tool'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			tool: NonNullable<import('../provider/index.js').StreamChunk['delta']['hostedTool']>
	  }
	/**
	 * A model call failed transiently and is being retried after a backoff.
	 *
	 * Answers the same question `tool_progress` answers — "is it still
	 * working?" — for the other half of a turn's wall clock. With the default
	 * policy, or a server-directed delay up to the cap, a turn can sit silent
	 * for the better part of a minute between `iteration_started` and the
	 * next event. A host saw literally nothing and no keepalive, so a
	 * backoff was indistinguishable from a hang and a watchdog would cancel
	 * a turn that was about to succeed.
	 *
	 * Emitted before the sleep, so the delay it names is the one still
	 * ahead.
	 */
	| {
			type: 'provider_retry'
			sessionId: SessionId
			turnId: TurnId
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
	/**
	 * A member of the provider chain could not serve, and a later member has
	 * taken over. The turn continues from where it stopped.
	 *
	 * This event is the feature's honesty. A chain that swapped silently would
	 * produce a turn that succeeded while quietly not doing what the operator
	 * asked — served by a provider they did not choose, at a price and a
	 * quality they did not agree to, with nothing in the transcript saying so.
	 * A host is expected to SHOW this, not log it.
	 *
	 * Emitted at the moment of the swap, before the replacement request runs.
	 */
	| {
			type: 'provider_fallback'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			/** 0-based position in the chain, as the host declared it. */
			fromIndex: number
			fromProviderId: string
			fromModel?: string
			toIndex: number
			toProviderId: string
			toModel?: string
			/** Classified failure code, as the boundary classifier reports it. */
			code: string
			status?: number
			/** The classified failure's own sentence. */
			reason: string
	  }
	| {
			type: 'tool_completed'
			/** Bounded result view; omitted when output was overridden or truncated. */
			presentation?: ToolResultView
			sessionId: SessionId
			turnId: TurnId
			toolUseId: ToolUseId
			toolName: string
			result: string
			isError: boolean
			/** See {@link tool_executing}'s `via`. Carried on both, so a
			 * consumer can pair them without holding the start event. */
			via?: {
				readonly tool: string
				readonly toolUseId: ToolUseId
				readonly runtimeToolCallId?: string
			}
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
			/** SHA-256 of the chunk manifest captured with the retained text. */
			outputSpillIntegrity?: string
	  }
	/**
	 * A tool asked the user a question and the turn is parked on it.
	 *
	 * The question used to park through the raw handler under a synthetic
	 * checkpoint id that was never written, so a remote host could not
	 * observe it at all — the in-process callback was the only channel, and
	 * a tool review with the same shape had an event, a bridge mapping and
	 * a durable record. This is that surface, for the other kind of park.
	 */
	| {
			type: 'user_question_asked'
			sessionId: SessionId
			turnId: TurnId
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
			sessionId: SessionId
			turnId: TurnId
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
			sessionId: SessionId
			turnId: TurnId
			toolCalls: ToolCallSummary[]
			iteration: number
	  }
	| {
			type: 'tool_review_completed'
			sessionId: SessionId
			turnId: TurnId
			decision: 'approved' | 'modified' | 'rejected'
	  }
	| {
			type: 'checkpoint_created'
			sessionId: SessionId
			turnId: TurnId
			checkpointId: CheckpointId
			iteration: number
	  }
	/**
	 * The turn parked at a checkpoint. This ends a segment of the turn and is
	 * NOT terminal: the turn stays the session's active turn until
	 * `resumeSession` continues it (same `turnId`) or `abandonTurn` closes it.
	 */
	| {
			type: 'turn_paused'
			budget?: TokenBudgetSummary
			sessionId: SessionId
			turnId: TurnId
			checkpointId: CheckpointId
			reason: string
			/**
			 * The same structured failure projection a terminal `turn_failed`
			 * carries. A pause is a different verdict, not a less informative one:
			 * the retryability and any provider-directed delay are what let a host
			 * decide when and how to resume this checkpoint.
			 */
			failure?: PlatformError
			/** First-hand driver classification, when the provider produced one. */
			providerError?: import('../provider/error.js').ProviderErrorInfo
			/** Curated operator copy, absent when no catalog rule matched. */
			explanation?: { id: string; message: string; hint: string }
	  }
	/** A paused turn continues from its checkpoint, under the same `turnId`. */
	| {
			type: 'turn_resuming'
			sessionId: SessionId
			turnId: TurnId
			fromCheckpointId: CheckpointId
			/** The decision whose answer released the park, when one did. */
			resolvedDecisionId?: string
	  }
	/**
	 * A guardrail blocked or rewrote the turn's input or answer.
	 *
	 * Emitted so a host can show WHY a turn refused, and — for a rewrite —
	 * so a consumer that already rendered `text_delta` events knows the
	 * text it displayed has been corrected.
	 */
	| {
			type: 'guardrail_triggered'
			sessionId: SessionId
			turnId: TurnId
			stage: 'input' | 'output'
			action: 'block' | 'rewrite'
			guardrail?: string
			reason?: string
	  }
	/**
	 * A background job this session (or the owner it runs under) started has
	 * ended. The model learns it from a notice on its next tool result;
	 * the host learns it from this, whether or not a turn is running.
	 */
	| {
			type: 'background_job_exited'
			sessionId: SessionId
			turnId?: TurnId
			jobId: string
			command: string
			status: 'exited' | 'killed'
			exitCode?: number
			signal?: string
	  }
	/**
	 * What the turn learned was written to the host's memory store: its
	 * decisions, discoveries and failures as one entry a later session can
	 * search for. Emitted only when a host asked (`consolidateInto`) and
	 * the turn had something to say.
	 */
	| {
			type: 'memory_consolidated'
			sessionId: SessionId
			turnId?: TurnId
			memoryId: string
			title: string
			decisions: number
			discoveries: number
			failures: number
	  }
	/**
	 * The turn reached its end without throwing.
	 *
	 * `completed` is not `succeeded`. A turn stopped by its token budget, its
	 * timeout, its iteration cap, a cancellation or a blocking output guardrail
	 * all arrive here — `turn_failed` is emitted only from the throw path — so a
	 * consumer that treated this event as success reported one for a turn whose
	 * answer was refused. `stopReason` and `settlement.status` separate them.
	 *
	 * `result` is the authoritative answer, after guardrail, review,
	 * outstanding-work and structured-output overrides. When it differs from the
	 * text of the turn's last assistant message, a `message_replaced` record is
	 * appended first, so every fold of the log shows this answer and never the
	 * raw one (`settlement.resultSource` says which override applied).
	 */
	| {
			type: 'turn_completed'
			budget?: TokenBudgetSummary
			sessionId: SessionId
			turnId: TurnId
			result: string
			stopReason?: StopReason
			/**
			 * Present only on a cancellation whose origin was recorded. Absent
			 * is a real answer: a cancellation nobody attributed is not a user
			 * cancellation, and defaulting to one would put a confident wrong
			 * value where an honest gap belongs.
			 */
			cancelCause?: CancelCause
			settlement: TurnSettlement
	  }
	/**
	 * The turn failed. Terminal, like `turn_completed`.
	 *
	 * `failure.code` names machine-readable causes the session log itself
	 * produces: `interrupted` (closed by `beginTurn({ abandonInterrupted })`
	 * after a crash) and `abandoned` (closed by `abandonTurn`).
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
			type: 'turn_failed'
			budget?: TokenBudgetSummary
			sessionId: SessionId
			turnId: TurnId
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
			settlement: TurnSettlement
	  }
	// Additive 2026-07 (provider capability negotiation): emitted once per
	// turn when the request asks for something the provider DRIVER declared
	// it cannot do — tools registered against a no-tools driver (tool
	// surfaces stripped so the model is never told about uncallable
	// tools), image attachments against a no-vision driver, document
	// attachments against a no-documents driver, or rich tool blocks against a
	// result wire that only carries text. Hosts surface these so degradation is
	// visible, not silent.
	| {
			type: 'capability_warning'
			sessionId: SessionId
			turnId?: TurnId
			capability: 'tools' | 'vision' | 'documents'
			/** Present when the mismatch was produced after a tool executed. */
			contentSource?: 'tool-result'
			providerId: string
			message: string
	  }
	/**
	 * Provider-invalid tool history was repaired before the first model call.
	 *
	 * Counts, not content: a host can surface and audit the rewrite without
	 * copying tool output or conversation secrets into its event channel.
	 * `fresh-history` names caller-supplied history. `abandoned-checkpoint`
	 * excludes any incomplete turn still owned by a durable pending/recovered
	 * resume plan; that turn is completed by its authority path instead.
	 */
	| {
			type: 'message_history_repaired'
			sessionId: SessionId
			turnId: TurnId
			source: 'fresh-history' | 'abandoned-checkpoint' | 'provider-rejected-image'
			duplicateToolResultsRemoved: number
			orphanedToolResultsRemoved: number
			syntheticToolResultsInserted: number
			/** Exact number of durable image occurrences withheld from later requests. */
			providerRejectedImagesSuppressed?: number
	  }
	| {
			type: 'token_usage_updated'
			/** Aggregate tree spend, distinct from this turn's own usage. */
			budget?: TokenBudgetSummary
			sessionId: SessionId
			turnId: TurnId
			usage: TokenUsage
			cost: CostInfo
			/**
			 * How large the CONTEXT is right now, and how large it may get.
			 *
			 * These are a different quantity from `usage` beside them and the
			 * distinction is the whole reason they are named this explicitly.
			 * `usage` is CUMULATIVE SPEND over the turn: prompt plus completion
			 * tokens summed across every turn, monotonically increasing, and
			 * untouched by compaction. `contextTokens` is the size of the
			 * conversation being sent right now, which falls when a compaction
			 * sheds.
			 *
			 * Dividing the first by a context window is a category error, and
			 * it is one this estate shipped: a host did exactly that, so its
			 * indicator climbed toward full on any long session no matter how much
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
			 * Absent when the turn has no compaction configuration, because
			 * nothing then resolves a window and inventing one would be the
			 * guess this exists to replace.
			 *
			 * This is a state snapshot, not merely a receipt for a model call.
			 * It is also emitted immediately after an automatic context edit:
			 * cumulative `usage`/`cost` may be unchanged (or may include a
			 * verifier call) while `contextTokens` falls to its post-edit
			 * estimate. Hosts therefore need not wait for another provider
			 * response to learn that compaction made room.
			 */
			contextTokens?: number
			contextMeasuredBy?: 'provider' | 'estimate'
			contextWindowTokens?: number
			windowSource?: 'config' | 'provider' | 'model-table' | 'default'
	  }
	| {
			type: 'activity_created'
			sessionId: SessionId
			turnId: TurnId
			activityId: ActivityId
			activityType: ActivityType
			description: string
	  }
	| {
			type: 'activity_updated'
			sessionId: SessionId
			turnId: TurnId
			activityId: ActivityId
			status: ActivityStatus
			output?: unknown
			error?: string
	  }
	| {
			type: 'plan_ready'
			sessionId: SessionId
			turnId: TurnId
			planId: PlanId
			title: string
			steps: PlanStep[]
			summary?: string
	  }
	| { type: 'plan_approved'; sessionId: SessionId; turnId: TurnId; planId: PlanId }
	| {
			type: 'plan_rejected'
			sessionId: SessionId
			turnId: TurnId
			planId: PlanId
			reason?: string
	  }
	| {
			type: 'plan_step_updated'
			sessionId: SessionId
			turnId: TurnId
			planId: PlanId
			stepId: string
			status: PlanStep['status']
	  }
	/**
	 * The plan is over, and it went the way it was supposed to.
	 *
	 * The plan events used to stop before the outcome: `plan_ready`,
	 * `plan_approved`, `plan_rejected` and `plan_step_updated` all reached the
	 * wire, and the two terminal ones were folded into a bare `break` in the
	 * translator. So a host watching the stream saw the steps report and then
	 * silence — it could tell a plan had been approved and never that it
	 * closed, which leaves a plan rendered as in-flight forever.
	 *
	 * Found by the first live end-to-end run rather than by a test, and the
	 * reason is worth keeping: the tests read the outcome off `PlanManager`
	 * through `onContextCreated`, so they proved the plan settled without ever
	 * asking whether a consumer of the EVENT STREAM could see it.
	 */
	| { type: 'plan_completed'; sessionId: SessionId; turnId: TurnId; planId: PlanId }
	/**
	 * The plan is over and it did not finish.
	 *
	 * `reason` is the text handed to `failPlan`, which used to be discarded —
	 * an event that says "failed" without saying why puts the reader back
	 * where the missing event did.
	 */
	| { type: 'plan_failed'; sessionId: SessionId; turnId: TurnId; planId: PlanId; reason?: string }
	| {
			type: 'agent_pending'
			sessionId: SessionId
			turnId: TurnId
			taskId: TaskId
			parentAgentId: string
			childAgentId: string
			depth: number
			/** Approved plan edge carried while the blocking tool is still live. */
			planId?: string
			planStepId?: string
			/**
			 * How the host that delegated this child wants it GROUPED on screen —
			 * a shared label over a set of related delegations, typically one
			 * operator-visible piece of work several children are doing together.
			 *
			 * These fields are display annotations only; they do not create
			 * dependencies, barriers, or serial execution. Nothing in the kernel
			 * reads them: admission, ordering and concurrency come from the
			 * scheduler and from {@link planId}/{@link planStepId}, which is the
			 * field pair that DOES carry correlation a host may act on. A reader
			 * who infers execution structure from a label here has inferred it
			 * from a caption.
			 *
			 * Absent unless the delegating host supplied them, which is the
			 * normal case — a host that groups nothing sends nothing, and a
			 * consumer written before these existed reads the same event it
			 * always did.
			 *
			 * They ride this event rather than staying in the delegating
			 * process's memory for REACH: a consumer watching from outside
			 * that process — another listener, or an SSE client — can rebuild
			 * the same picture instead of seeing an undifferentiated list of
			 * children.
			 *
			 * Reach is not durability, and this event buys only the first.
			 * Like every delegation lifecycle event, it is handed straight to
			 * a host's listener and never enters a session log — which is what
			 * the absent `seq` on this variant says, and what the `seq` doc
			 * above spells out. A label here is therefore written nowhere by
			 * the kernel and does not survive a restart of the host that chose
			 * it; a host wanting the grouping to outlive its process records it
			 * from the listener.
			 */
			workflow?: string
			/**
			 * Display group WITHIN {@link workflow} — a stage of that work, as
			 * the delegating host labelled it. Display-only on the same terms as
			 * {@link workflow}: it creates no dependencies, barriers or serial
			 * execution, and two children naming the same phase are not thereby
			 * sequenced or synchronised.
			 */
			phase?: string
			/**
			 * Longer text explaining {@link phase}, for a surface that has room
			 * to show it. Display-only on the same terms as {@link workflow}.
			 */
			phaseDetail?: string
			/**
			 * Where {@link phase} sits in the host's intended DISPLAY order,
			 * zero-based. Display-only on the same terms as {@link workflow}: it
			 * orders a list on a screen and orders nothing that runs. Children in
			 * one phase are expected to carry the same value; a consumer that
			 * sees two disagree should keep the first rather than resequence,
			 * because nothing here is authoritative enough to arbitrate.
			 */
			phaseOrder?: number
	  }
	| {
			type: 'agent_completed'
			sessionId: SessionId
			turnId: TurnId
			taskId: TaskId
			result: BaseAgentResult
	  }
	| {
			type: 'agent_failed'
			sessionId: SessionId
			turnId: TurnId
			taskId: TaskId
			error: string
	  }
	| {
			type: 'agent_canceled'
			sessionId: SessionId
			turnId: TurnId
			taskId: TaskId
			/** Same value the child's own `turn_completed` carries, so the two
			 *  sides of one cancellation agree rather than being correlated
			 *  by timing. */
			cancelCause?: CancelCause
	  }
	| {
			type: 'task_created'
			sessionId: SessionId
			turnId?: TurnId
			taskId: TaskId
			subject: string
			status: TaskStatus
			/**
			 * What this unit waits on, and who claims it.
			 *
			 * The store maintains a full dependency graph — `blocks` and
			 * `blockedBy` are mirrored on both ends, written under a lock, and
			 * deadlock-avoided — and none of it reached the wire. So a host
			 * could show a flat list of units and nothing about their order,
			 * while the model was already maintaining the order.
			 *
			 * Absent rather than empty when the unit depends on nothing, so a
			 * reader can tell "no dependencies" from an emitter that predates
			 * these fields.
			 */
			blockedBy?: readonly TaskId[]
			owner?: string
	  }
	| {
			type: 'task_updated'
			sessionId: SessionId
			turnId?: TurnId
			taskId: TaskId
			subject: string
			status: TaskStatus
			owner?: string
			/** See `task_created`. Carried on updates because an edge can be added later. */
			blockedBy?: readonly TaskId[]
	  }
	| {
			type: 'plugin_hook_executing'
			sessionId: SessionId
			turnId?: TurnId
			pluginId: PluginId
			hookEvent: PluginHookEvent
	  }
	| {
			type: 'plugin_hook_completed'
			sessionId: SessionId
			turnId?: TurnId
			pluginId: PluginId
			hookEvent: PluginHookEvent
			result: PluginHookResult
	  }
	| {
			type: 'sandbox_created'
			sessionId: SessionId
			turnId?: TurnId
			sandboxId: SandboxId
			environment: string
	  }
	| {
			type: 'sandbox_exec'
			sessionId: SessionId
			turnId?: TurnId
			sandboxId: SandboxId
			command: string
			exitCode: number
			durationMs: number
	  }
	| { type: 'sandbox_destroyed'; sessionId: SessionId; turnId?: TurnId; sandboxId: SandboxId }
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
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			messageId: MessageId
	  }
	/**
	 * The model began emitting a reasoning block.
	 *
	 * Without these, extended thinking looked to a streaming UI like a
	 * multi-second stall with no events at all — the turn was working, and
	 * the host had no way to say so.
	 */
	| {
			type: 'reasoning_started'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			messageId: MessageId
			blockIndex: number
			reasoningType: 'thinking' | 'redacted_thinking'
	  }
	/** Ephemeral — never appended to the session log, like `text_delta`. */
	| {
			type: 'reasoning_delta'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			messageId: MessageId
			blockIndex: number
			text: string
	  }
	| {
			type: 'reasoning_completed'
			sessionId: SessionId
			turnId: TurnId
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
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			messageId: MessageId
			text: string
			textPart?: Omit<import('../message/index.js').AssistantTextPart, 'text'>
	  }
	| {
			type: 'message_completed'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			messageId: MessageId
			stopReason: MessageStopReason
			usage?: TokenUsage
			/**
			 * Settled assistant text. When the provider supplies public text
			 * phases, this selects explicit final-answer items; concatenating
			 * raw deltas would also include intermediate commentary. All items
			 * remain available in textParts. Without phases, ordinary delta
			 * concatenation is unchanged. Stop reason still determines whether
			 * this message finished, was cancelled or hit an output limit.
			 */
			content?: string
			/** Ordered original items; content selects explicit final answers if supplied. */
			textParts?: readonly import('../message/index.js').AssistantTextPart[]
	  }
	| {
			type: 'tool_input_started'
			sessionId: SessionId
			turnId: TurnId
			iteration: number
			messageId: MessageId
			toolUseId: ToolUseId
			toolName: string
	  }
	| {
			type: 'tool_input_delta'
			sessionId: SessionId
			turnId: TurnId
			toolUseId: ToolUseId
			partialJson: string
	  }
	| {
			type: 'tool_input_completed'
			sessionId: SessionId
			turnId: TurnId
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
 * A child session was created to do delegated work. Appended to the PARENT
 * session's log, inside the parent turn whose tool call spawned it.
 */
export interface ChildSessionSpawnedEvent {
	type: 'child_session_spawned'
	sessionId: SessionId
	turnId: TurnId
	childSessionId: SessionId
	/** The parent's tool call that spawned the child. */
	toolCallId: ToolUseId
	kind: SubSessionKind
	description: string
	/** The child's log, relative to the parent's session directory: `subagents/<child-id>.jsonl`. */
	path: string
	/**
	 * Display grouping a host asked for, for example one operator-visible piece
	 * of work several children do together. Batches are derived from these
	 * annotations; nothing executes differently because of them.
	 */
	batch?: { batchId: string; name: string; phase?: string }
	/** The token-budget account the child's turns spend from. */
	budgetAccountId?: string
}

/** The child session appended a message. */
export interface ChildSessionMessagedEvent {
	type: 'child_session_messaged'
	sessionId: SessionId
	turnId: TurnId
	childSessionId: SessionId
	messageId: MessageId
}

/** The child session went idle: its current turn ended and nothing is queued. */
export interface ChildSessionIdledEvent {
	type: 'child_session_idled'
	sessionId: SessionId
	turnId: TurnId
	childSessionId: SessionId
}

export type ChildSessionLifecycleEvent =
	| ChildSessionSpawnedEvent
	| ChildSessionMessagedEvent
	| ChildSessionIdledEvent

/**
 * Discriminated union of every live session event: 62 type literals.
 *
 * `type` is the sole discriminator for exhaustive switches; envelope fields
 * are additive and never take part in discrimination.
 */
export type SessionEvent =
	| (CoreSessionEvent & SessionEventEnvelope)
	| (ChildSessionLifecycleEvent & SessionEventEnvelope)

export type { CoreSessionEvent }

export type SessionEventType = SessionEvent['type']

export type SessionEventListener = (event: SessionEvent) => void | Promise<void>

/**
 * Event types whose volume makes durable persistence wasteful. They reach the
 * live stream and never the session log: the completed message, reasoning
 * block and tool input carry the same content once.
 */
export const EPHEMERAL_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set<SessionEventType>([
	'text_delta',
	'tool_input_delta',
	'reasoning_delta',
	'tool_progress',
])

export function isEphemeralEvent(event: { readonly type: string }): boolean {
	return EPHEMERAL_EVENT_TYPES.has(event.type as SessionEventType)
}

/** The event types a session log records: every literal except the ephemeral four. */
export type PersistedSessionEventType = Exclude<
	SessionEventType,
	'text_delta' | 'tool_input_delta' | 'reasoning_delta' | 'tool_progress'
>
