import type { StepResult } from '../types/run/step.js'

/**
 * One case in a dataset: an input, and what a good run looks like.
 *
 * `TInput` is the agent's own input type, so a dataset is checked against
 * the thing it tests rather than against `unknown`.
 */
export interface EvalCase<TInput = unknown> {
	name: string
	input: TInput
	/** Free-form expectation, consumed by whichever scorers you attach. */
	expected?: unknown
	/**
	 * Tool names the run is expected to call, in order. Consumed by
	 * `trajectoryScorer`.
	 */
	expectedTools?: readonly string[]
	/** Per-case scorer overrides; falls back to the dataset's scorers. */
	scorers?: readonly Scorer[]
}

/** What actually happened, handed to every scorer. */
export interface EvalRun {
	/** Final assistant text, when the run produced one. */
	output: string | null
	/** Schema-validated final output, when `structuredOutput` was requested. */
	structuredOutput?: unknown
	steps: readonly StepResult[]
	/** Tool names in call order, flattened across steps. */
	toolCalls: readonly string[]
	stopReason?: string
	totalTokens: number
	totalCostUsd: number
	durationMs: number
	/** Set when the run threw rather than settling. */
	error?: string
}

/**
 * A judgement about one run.
 *
 * `reason` is REQUIRED, not optional. A bare number tells you a run got
 * worse without telling you how, which is exactly when you need to know —
 * so every scorer has to be able to explain itself, and one that cannot
 * is a scorer that should not exist. Mastra makes the same call.
 */
export interface Score {
	/** 0..1. Higher is better. */
	score: number
	reason: string
	/** Anything the scorer wants to surface (counts, diffs, matched items). */
	details?: Record<string, unknown>
}

export interface Scorer {
	name: string
	score(run: EvalRun, evalCase: EvalCase): Score | Promise<Score>
}

export interface CaseResult {
	case: string
	run: EvalRun
	scores: Record<string, Score>
	/** Mean of this case's scores. */
	mean: number
	passed: boolean
}

export interface ExperimentReport {
	name: string
	cases: readonly CaseResult[]
	/** Mean score across all cases. */
	mean: number
	passed: number
	failed: number
	/** Per-scorer means, for spotting which dimension regressed. */
	byScorer: Record<string, number>
	durationMs: number
}
