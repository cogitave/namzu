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
	model: string
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
