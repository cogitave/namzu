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
 * is a scorer that should not exist.
 */
export interface Score {
	/** 0..1. Higher is better. Ignored when `unavailable` is set. */
	score: number
	reason: string
	/** Anything the scorer wants to surface (counts, diffs, matched items). */
	details?: Record<string, unknown>
	/**
	 * The scorer could not produce a judgement — it threw, its provider was
	 * unreachable, its verdict did not parse.
	 *
	 * A failed measurement is not a measurement of zero. Scoring it zero
	 * says "the run was bad" when the truth is "we do not know", and the
	 * two demand opposite responses: one is a regression to chase, the
	 * other is a broken harness to fix. This mattered little while every
	 * scorer was a pure function — a throw there is a bug — and matters a
	 * great deal now that a scorer can be a network call, where one 429
	 * would otherwise turn a green suite red and send somebody hunting a
	 * regression that never happened.
	 *
	 * An unavailable score is excluded from the case mean's numerator AND
	 * its denominator, and the case it belongs to is reported as
	 * inconclusive rather than passed or failed.
	 */
	unavailable?: boolean
}

export interface Scorer {
	name: string
	score(run: EvalRun, evalCase: EvalCase): Score | Promise<Score>
}

/**
 * `inconclusive` is a first-class outcome: every scorer that ran was
 * unavailable, so there is no evidence either way. Folding it into
 * `failed` invents a regression and folding it into `passed` invents
 * evidence; both are worse than saying nothing was measured.
 */
export type CaseStatus = 'passed' | 'failed' | 'inconclusive'

export interface CaseResult {
	case: string
	run: EvalRun
	scores: Record<string, Score>
	/** Mean of this case's AVAILABLE scores. Zero when none were. */
	mean: number
	status: CaseStatus
	/** True only for `status: 'passed'`. */
	passed: boolean
}

export interface ExperimentReport {
	name: string
	cases: readonly CaseResult[]
	/** Mean score across the cases that produced one. */
	mean: number
	passed: number
	failed: number
	/** Cases where no scorer could produce a judgement. */
	inconclusive: number
	/**
	 * Per-scorer means over the cases each one actually judged, for
	 * spotting which dimension regressed. A scorer that was unavailable on
	 * some cases is averaged over the rest rather than dragged toward zero.
	 */
	byScorer: Record<string, number>
	durationMs: number
}
