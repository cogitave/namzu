import type { CostInfo, TokenUsage } from '../common/index.js'
import type { MessageId } from '../ids/index.js'
import type { ToolCall } from '../message/index.js'
import type { ProviderErrorCode } from '../provider/errors.js'

/**
 * What one iteration of the agent loop did.
 *
 * None of this was reachable before. `Run` and `BaseAgentResult` have no
 * `steps[]`, so a host that persisted the returned `Run` — the natural
 * thing — permanently lost per-step attribution: answering "which step
 * cost the most" meant correlating raw `RunEvent`s by iteration number and
 * diffing cumulative counters, and per-tool duration was never emitted at
 * all. Every field here was already computed somewhere in the loop.
 */
export interface StepResult {
	/** 1-based, matching `iteration` on the run events. */
	stepNumber: number
	/**
	 * The model this step ASKED for: the run's configured model, or the
	 * override a `prepareStep` hook returned for this step.
	 *
	 * It used to be the run's model unconditionally — the loop passed its own
	 * `model` here while building the request from `step.model ?? model` a few
	 * lines above — so a host that routed one step to a cheaper model read the
	 * expensive one back out of the ledger. No chain was needed to see it.
	 *
	 * What was asked for and what answered are two facts, and after a provider
	 * chain falls over they differ. This is the first; {@link servedBy} is the
	 * second.
	 */
	model: string
	/**
	 * Who actually answered, and with which model.
	 *
	 * Equal to {@link model} and to `run.metadata.provider` on every run
	 * without a chain, which is most of them; it diverges exactly when
	 * `withProviderFallback` advanced. Recorded even when it agrees, because a
	 * ledger that carries the fact only when it is surprising cannot be read as
	 * evidence — a reader could not tell "the head served" from "nobody wrote
	 * it down".
	 *
	 * Optional only for records that predate the field. Absence means "not
	 * recorded", and it is left meaning that rather than backfilled: the sdk
	 * shipped a chain that could fall over one release before it recorded
	 * which member did, so filling those in from the declared head would state
	 * as fact the exact thing that release got wrong, on exactly the runs
	 * where it was wrong. Every step this build produces has it.
	 *
	 * **Reaches a host through the returned `Run`, not through `run.json`.**
	 * `RunDiskStore.writeRunMeta` persists the metadata and the counters and
	 * does not write `steps` at all, so the built-in store carries the
	 * run-level {@link
	 * import('./entity.js').RunStateMetadata.servingProvider} and none of
	 * this. A host that wants per-step provenance on disk persists the `Run`
	 * it is handed.
	 */
	servedBy?: StepProvenance
	/**
	 * The assistant message this step produced.
	 *
	 * Absent only on a step whose iteration ended before the model's message
	 * was announced — a compaction failure, a lifecycle hook that threw, a
	 * transport error raised before the first chunk. Absence is left meaning
	 * "there was no message" rather than filled with an id the event stream
	 * never carried: a `messageId` a reader cannot find a `message_started`
	 * for is worse evidence than no id at all, because it invites the
	 * correlation and then loses it.
	 *
	 * Present, and correlatable, on every step whose iteration got as far as
	 * the provider call — including one that failed mid-stream. The loop
	 * mints the id before the call that announces it, and a dying stream
	 * emits `message_completed` on its way out, so the events carry both
	 * ends of the message a failed step points at.
	 */
	messageId?: MessageId
	/** Assistant text for this step, if any. */
	content: string | null
	toolCalls: readonly ToolCall[]
	/**
	 * Tool outcomes, in the same order as `toolCalls`.
	 *
	 * Shorter than `toolCalls` on a step that ended in failure: only the
	 * outcomes that exist are recorded, so a call with no entry here reads
	 * as "never came back" rather than as an empty success. Pair by
	 * `toolCallId`, not by index.
	 */
	toolResults: readonly StepToolResult[]
	/**
	 * How the turn ended.
	 *
	 * `error` and `cancelled` are not provider verdicts — no provider reports
	 * them — but a step exists for a failed iteration too, and it has to say
	 * how it ended in the same field a reader already sorts by. `error` comes
	 * with {@link failure}; `cancelled` means a Stop tore the turn down and
	 * there is no failure to report.
	 */
	finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'cancelled'
	/**
	 * What went wrong, on a step with `finishReason: 'error'`.
	 *
	 * Absent everywhere else. A run whose ledger is complete except on the
	 * turns that failed reads as "nothing went wrong" precisely when
	 * something did, which is worse than an absent record — so the failed
	 * turn gets the same record as every other, and this is what makes it
	 * legible as a failure.
	 */
	failure?: StepFailure
	/** Usage for THIS step, not the run's cumulative total. */
	usage: TokenUsage
	/** Cost delta attributable to this step. Zero without a pricing table. */
	costDelta: CostInfo
	startedAt: number
	/** Wall-clock for the whole step, including tool execution. */
	durationMs: number
	/** Portion of `durationMs` spent inside tools. */
	toolExecutionMs: number
}

/**
 * The chain member that served one step.
 *
 * `chainIndex` is a position in the chain the host declared, and it is here
 * rather than derived from `providerId` because a chain may legitimately name
 * the same provider twice — two models, or two credentials, on one driver.
 * `providerId` alone could not tell those apart.
 */
export interface StepProvenance {
	readonly providerId: string
	readonly model: string
	/** 0 is the head, i.e. the provider the run was configured with. */
	readonly chainIndex: number
}

/**
 * Why a step ended in `finishReason: 'error'`.
 *
 * The step-level counterpart of the pair a failed run already carries —
 * {@link import('./entity.js').Run.lastError} and
 * {@link import('./entity.js').Run.lastProviderError} — and shaped from the
 * same classification, so the two agree when the failed step is the one that
 * ended the run. What a run records once, a run of twenty iterations records
 * per iteration, which is the difference between "this run failed" and "this
 * turn failed, and the next four succeeded".
 */
export interface StepFailure {
	/** The failure's message, as the iteration's span and log recorded it. */
	readonly message: string
	/**
	 * Where the classifier placed it.
	 *
	 * `unknown` for a failure that is not a provider failure at all — a
	 * plugin hook that threw, a bug in a tool wrapper. That is the honest
	 * reading of the code's own contract ("unclassifiable"), and it is left
	 * saying so rather than being given a more specific-looking code.
	 */
	readonly code: ProviderErrorCode
	/** HTTP status, when the failure carried one. */
	readonly status?: number
	/** Whether sending the same request again could have worked. */
	readonly retryable: boolean
}

export interface StepToolResult {
	toolCallId: string
	toolName: string
	/** Text form, after the model-visible output budget was applied. */
	output: string
	isError: boolean
	durationMs: number
}

/**
 * A programmable halt condition, evaluated after each step's tools have
 * run.
 *
 * `GuardCoordinator` — the only halt before this — consumes
 * `{aborted, totalTokens, totalCost, currentIteration, startTime}` and
 * never sees messages, tool calls or results. So "stop after three steps
 * with no progress" and "stop once the plan is complete" were
 * inexpressible, and a terminal `submit_answer` tool could not end the
 * run: the model had to be prompt-begged to stop, with `maxIterations:
 * 200` as the only backstop.
 *
 * Returning `true` ends the run with `stop_reason: 'stop_condition'`.
 */
export type StopCondition = (state: StopConditionState) => boolean | Promise<boolean>

export interface StopConditionState {
	/** Every step so far, most recent last. */
	readonly steps: readonly StepResult[]
	readonly latestStep: StepResult
	readonly totalUsage: TokenUsage
	readonly totalCost: CostInfo
}

/** Stop once `n` steps have completed. */
export function stepCountIs(n: number): StopCondition {
	return ({ steps }) => steps.length >= n
}

/**
 * Stop when the latest step called any of `names`.
 *
 * The tool still executes and its result is still recorded — the run ends
 * after, not instead. That is what makes a `submit_answer` / `verify` tool
 * usable as a terminator without losing its output.
 */
export function hasToolCall(...names: string[]): StopCondition {
	const wanted = new Set(names)
	return ({ latestStep }) => latestStep.toolCalls.some((tc) => wanted.has(tc.function.name))
}

/** Stop when any of the given conditions does. */
export function anyOf(...conditions: StopCondition[]): StopCondition {
	return async (state) => {
		for (const condition of conditions) {
			if (await condition(state)) return true
		}
		return false
	}
}
