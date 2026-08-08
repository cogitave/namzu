import type { CostInfo, TokenUsage } from '../common/index.js'
import type { MessageId } from '../ids/index.js'
import type { ToolCall } from '../message/index.js'

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
	messageId: MessageId
	/** Assistant text for this step, if any. */
	content: string | null
	toolCalls: readonly ToolCall[]
	/** Tool outcomes, in the same order as `toolCalls`. */
	toolResults: readonly StepToolResult[]
	finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter'
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
