import type { StepResult } from '../types/run/step.js'
import type { ScoreUncertainty } from './uncertainty.js'

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

/**
 * How a scorer's verdict affects the case's.
 *
 * A single unweighted mean over every scorer, compared to one suite-wide
 * threshold, made the two halves of the design fight each other. At the
 * default threshold of 1 the harness never reports a false pass — but a
 * trajectory F1 and a graded judge can essentially never reach 1, so every
 * real suite lowers it. And every step down buys tolerance for the fuzzy
 * scorers by buying the same tolerance for the deterministic ones: at 0.75,
 * a trajectory score of 0 alongside three perfect scores averages to 0.75
 * and reports **passed**. The exact regression the harness exists to catch
 * comes back green.
 *
 *  - `gate` — a miss fails the case outright, whatever the mean says.
 *    For the deterministic checks: it called the wrong tools, it did not
 *    finish, the required phrase is absent.
 *  - `soft` — contributes to the mean only. For the fuzzy ones, where a
 *    number below 1 is normal and a threshold is a judgement call.
 *
 * Defaults to `soft`, so a suite that sets nothing behaves exactly as
 * before.
 */
export type ScorerSeverity = 'gate' | 'soft'

export interface Scorer {
	name: string
	score(run: EvalRun, evalCase: EvalCase): Score | Promise<Score>
	/** See {@link ScorerSeverity}. Default `soft`. */
	severity?: ScorerSeverity
	/**
	 * The score this scorer must reach. Defaults to the experiment's
	 * `passThreshold`.
	 *
	 * Per-scorer because "good enough" is not one number across dimensions:
	 * a trajectory match at 0.8 may be fine while a completion check at 0.8
	 * is meaningless — it either finished or it did not.
	 */
	threshold?: number
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
	/**
	 * Gate scorers that missed their threshold, by name.
	 *
	 * Named rather than counted: a case reported failed with a mean of 0.75
	 * otherwise sends somebody to read four scores and guess which one
	 * mattered. Absent when no gate missed.
	 */
	failedGates?: readonly string[]
}

export interface ExperimentReport {
	name: string
	cases: readonly CaseResult[]
	/** Mean score across the cases that produced one. */
	mean: number
	/**
	 * How much of {@link mean} is signal.
	 *
	 * A mean on its own has been read as a result, and at the n a
	 * hand-built suite has it usually is not one: two runs three points
	 * apart are normally the same run twice.
	 *
	 * Optional, and deliberately so after trying it the other way. A suite
	 * file is loaded at runtime and may be plain JavaScript, so a required
	 * field is not enforced at the boundary that matters — it buys type
	 * safety for one kind of consumer and a crash for the other. Producers
	 * that go through `runExperiment` always set it; `formatReport` derives
	 * it from {@link cases} when a hand-built report does not, so no report
	 * is printed without an interval either way.
	 */
	uncertainty?: ScoreUncertainty
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
