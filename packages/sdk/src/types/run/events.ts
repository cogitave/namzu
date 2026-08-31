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
import type { Message } from '../message/index.js'
import type { PlanStep } from '../plan/index.js'
import type { PluginHookEvent, PluginHookResult } from '../plugin/index.js'
import type { TaskStatus } from '../task/index.js'
import type { CancelCause } from './cancel-cause.js'
import type { FencingToken } from './checkpoint-store.js'
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
	/**
	 * This event's position in its OWN run's durable event log, from 1.
	 *
	 * **Present means recorded.** The emitter takes a candidate number, appends
	 * the event stamped with it, and only then advances the counter and hands
	 * the event to the live stream — so a `seq` a consumer can see is a `seq`
	 * the log contains. That is what makes it usable as a cursor: reconnect,
	 * ask for everything above it, and nothing is missed and nothing arrives
	 * twice.
	 *
	 * **Absent means not recoverable**, and three different things arrive that
	 * way:
	 *
	 *  - the high-frequency events {@link isEphemeralEvent} names, which are
	 *    deliberately never persisted;
	 *  - an event whose durable write FAILED — it still reaches the live
	 *    stream, unstamped, because losing the news of a failure is worse than
	 *    delivering it without a cursor;
	 *  - the delegation lifecycle events (`agent_pending`, `agent_completed`,
	 *    `agent_failed`, `agent_canceled` and the three sub-session variants),
	 *    which the agent manager hands straight to a host's listener without
	 *    passing through the run's event translator at all. They are not in any
	 *    run's log, and the missing `seq` is how a consumer learns that rather
	 *    than discovering it after a reconnect.
	 *
	 * **Per run, not per stream.** A parent's listener also receives its
	 * children's events, each numbered in its own run's log, so a consumer
	 * keeps one cursor per `runId`. The SSE mapper carries the pair as
	 * `<runId>:<seq>` for exactly this reason.
	 *
	 * Monotonic under a single writer. The run store takes no claim fence
	 * today (see `QueryParams.claimFence`), so two workers that both took one
	 * run can both append — `generation` is what makes that detectable.
	 */
	seq?: number
	/**
	 * The claim fence the run was being written under, when it holds a claim.
	 *
	 * A sequence alone lies across a takeover: a client at seq 400 reconnects
	 * to a run whose store lost its log, the new writer starts at 1, and the
	 * client's cursor silently addresses a different sequence space. The fence
	 * is already the arbiter of who may write and it only increases, so
	 * carrying it here makes a takeover ORDERED rather than merely
	 * distinguishable.
	 *
	 * Absent when the run was written unfenced, which is every run that took no
	 * claim. A cursor then relies on the log persisting — the disk store's
	 * does, an in-memory store's does not, and `cursor_ahead` is the verdict
	 * that catches the difference.
	 */
	generation?: FencingToken
}

type CoreRunEvent =
	| { type: 'run_started'; runId: RunId; systemPrompt?: string }
	| { type: 'iteration_started'; runId: RunId; iteration: number }
	/**
	 * Who answers when this run asks a human, changed mid-run.
	 *
	 * The policy used to be a closure captured at `query()` start, so
	 * changing it meant ending the run. Now it is a value a host can swap —
	 * and a swap that left no trace would be the worst version of that: an
	 * incident review would see approvals with no way to tell which rule
	 * granted them.
	 *
	 * Names, not handlers. A durable log cannot hold a function, and
	 * `[Function (anonymous)]` is what a log says when somebody tries.
	 */
	| {
			type: 'approval_policy_changed'
			runId: RunId
			from: string
			to: string
			reason: string
	  }
	/**
	 * What the model was actually asked, when it changed.
	 *
	 * `run_started` records a system prompt once, and tool schemas never
	 * reached the transcript at all — yet the effective envelope changes
	 * mid-run: `prepareStep` rewrites the system text, narrows the tool
	 * list, or swaps the model, and a step's skills ride an ephemeral
	 * trailing system message. So a transcript showed one prompt and a run
	 * that had asked several different questions.
	 *
	 * Emitted only when the tuple DIFFERS from the last one recorded. The
	 * common case — nothing changed — costs one hash and no event, because
	 * a per-iteration copy of an unchanged system prompt is the fastest way
	 * to make a durable log too large to read.
	 */
	| {
			type: 'request_envelope'
			runId: RunId
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
	/**
	 * What a compaction pass removed, recorded before it is gone.
	 *
	 * `compaction_completed` carries counts and nothing else, and both shed
	 * sites REPLACE the live message array — which `persist()` then writes
	 * over `messages.json` wholesale. So the shed content existed nowhere
	 * afterwards: not in memory, not on disk, not in the transcript. "What
	 * did the agent decide three compactions ago" was unanswerable, an undo
	 * had no input, and a search index over run history could never see the
	 * part that mattered most.
	 *
	 * Emitted BEFORE the array is replaced, and that ordering is the whole
	 * mechanism: `transcript.jsonl` is append-only and `emitEvent` reaches it
	 * synchronously with the pass, so the record is durable before the
	 * deletion is. Emitted after, a crash between the two loses exactly what
	 * this exists to keep.
	 *
	 * This does NOT make the transcript the source of truth for a live run —
	 * the message array still is. It adds a parallel append-only record
	 * beside it.
	 *
	 * Carries whole message bodies, tool output included, which is why both
	 * external wire mappers decline it.
	 */
	| {
			type: 'compaction_shed'
			runId: RunId
			iteration: number
			/** Exactly the messages the pass removed, in their original order. */
			messages: Message[]
			/** Whether the pass ran on the threshold or on a provider rejection. */
			reason: 'threshold' | 'overflow'
	  }
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
			windowSource: 'config' | 'provider' | 'model-table' | 'default'
			/**
			 * False when the pass could not get the context below
			 * `resetThreshold` — the trigger is still armed, and a host may
			 * want to surface that the run is running tight.
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
	 * `transcript.jsonl` saw results it no longer has and no record of why.
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
			runId: RunId
			iteration: number
			/** How many `tool_result` bodies were emptied. */
			clearedCount: number
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
			/**
			 * Present when another TOOL dispatched this call, rather than the
			 * model.
			 *
			 * `run_code` is the reason: a program it runs calls tools in a
			 * loop, and those calls went through `registry.execute` directly —
			 * so they reached the permission gate and reached the event stream
			 * not at all. A run whose transcript showed one `run_code` call and
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
	 * Ephemeral — excluded from `transcript.jsonl`, like `text_delta`. It is
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
	/**
	 * A member of the provider chain could not serve, and a later member has
	 * taken over. The run continues from where it stopped.
	 *
	 * This event is the feature's honesty. A chain that swapped silently would
	 * produce a run that succeeded while quietly not doing what the operator
	 * asked — served by a provider they did not choose, at a price and a
	 * quality they did not agree to, with nothing in the transcript saying so.
	 * A host is expected to SHOW this, not log it.
	 *
	 * Emitted at the moment of the swap, before the replacement request runs.
	 */
	| {
			type: 'provider_fallback'
			runId: RunId
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
			runId: RunId
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
			/**
			 * The same structured failure projection a terminal `run_failed`
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
	| {
			type: 'run_completed'
			runId: RunId
			result: string
			stopReason?: StopReason
			/**
			 * Present only on a cancellation whose origin was recorded. Absent
			 * is a real answer: a cancellation nobody attributed is not a user
			 * cancellation, and defaulting to one would put a confident wrong
			 * value where an honest gap belongs.
			 */
			cancelCause?: CancelCause
	  }
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
	// tools), image attachments against a no-vision driver, document
	// attachments against a no-documents driver, or rich tool blocks against a
	// result wire that only carries text. Hosts surface these so degradation is
	// visible, not silent.
	| {
			type: 'capability_warning'
			runId: RunId
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
			runId: RunId
			source: 'fresh-history' | 'abandoned-checkpoint' | 'provider-rejected-image'
			duplicateToolResultsRemoved: number
			orphanedToolResultsRemoved: number
			syntheticToolResultsInserted: number
			/** Exact number of durable image occurrences withheld from later requests. */
			providerRejectedImagesSuppressed?: number
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
	| { type: 'plan_completed'; runId: RunId; planId: PlanId }
	/**
	 * The plan is over and it did not finish.
	 *
	 * `reason` is the text handed to `failPlan`, which used to be discarded —
	 * an event that says "failed" without saying why puts the reader back
	 * where the missing event did.
	 */
	| { type: 'plan_failed'; runId: RunId; planId: PlanId; reason?: string }
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
	| {
			type: 'agent_canceled'
			runId: RunId
			taskId: TaskId
			/** Same value the child's own `run_completed` carries, so the two
			 *  sides of one cancellation agree rather than being correlated
			 *  by timing. */
			cancelCause?: CancelCause
	  }
	| {
			type: 'task_created'
			runId: RunId
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
			runId: RunId
			taskId: TaskId
			subject: string
			status: TaskStatus
			owner?: string
			/** See `task_created`. Carried on updates because an edge can be added later. */
			blockedBy?: readonly TaskId[]
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
	// Intersected so `seq` is READABLE on every member of the union — TypeScript
	// refuses a property access on a union where one member lacks the field, and
	// a consumer holding a cursor has to be able to ask any event for its
	// number. These three never carry one, and that is the answer rather than an
	// omission: they are emitted straight to a host's listener and reach no run's
	// durable log.
	| (SubsessionSpawnedEvent & RunEventEnvelope)
	| (SubsessionMessagedEvent & RunEventEnvelope)
	| (SubsessionIdledEvent & RunEventEnvelope)

export type RunEventListener = (event: RunEvent) => void | Promise<void>

/**
 * A run event as the durable log gives it back.
 *
 * `seq` and `timestamp` are REQUIRED here and optional on the live envelope,
 * which is the whole difference between the two types: a recorded event has a
 * position and a moment, and a live one may be neither recorded nor
 * recoverable.
 *
 * `timestamp` is not new — both store implementations have always stamped it
 * on write. It was simply never declared anywhere, so the field was persisted
 * by two writers, typed by neither, and read by nobody. Declaring it is what
 * lets the read-back stop casting.
 */
export type PersistedRunEvent = RunEvent & {
	readonly seq: number
	/** Epoch ms at which the store recorded the event. */
	readonly timestamp: number
}

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
