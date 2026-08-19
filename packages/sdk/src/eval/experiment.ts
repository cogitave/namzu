import type {
	CaseResult,
	CaseStatus,
	EvalCase,
	EvalRun,
	ExperimentReport,
	Score,
	Scorer,
} from './types.js'
import type { ScoreUncertainty } from './uncertainty.js'
import { describeUncertainty, uncertaintyOf } from './uncertainty.js'

const MAX_CASE_TIMEOUT_MS = 2_147_483_647

export interface ExperimentConfig<TInput = unknown> {
	name: string
	cases: readonly EvalCase<TInput>[]
	/** Applied to every case unless the case overrides them. */
	scorers: readonly Scorer[]
	/**
	 * Execute one case. Returning an `EvalRun` rather than driving `query()`
	 * here keeps the harness independent of how you construct a run —
	 * scripted mock, real provider, or a whole agent behind a facade.
	 */
	run: (input: TInput, evalCase: EvalCase<TInput>, signal: AbortSignal) => Promise<EvalRun>
	/**
	 * Wall-clock deadline for one case, including execution and every
	 * scorer. Unset means no deadline.
	 *
	 * A non-cooperative `run` closure or scorer is detached by an independent
	 * race, so it cannot hold the suite forever. The same signal is passed to
	 * both phases; I/O-owning scorers should forward it to their transport,
	 * as `judgeScorer` does.
	 *
	 * A run that exhausts the budget is reported as failed. A scorer that
	 * exhausts the remainder is unavailable, making an otherwise unjudged
	 * case inconclusive. Either way the suite continues: forty cases should
	 * not be lost to one operation that hung.
	 */
	timeoutMs?: number
	/** Mean score a case must reach to count as passed. Default 1. */
	passThreshold?: number
	/** Cases to run at once. Default 1 — deterministic ordering by default. */
	concurrency?: number
	onCaseFinish?: (result: CaseResult) => void
}

/**
 * Run a dataset and score it.
 *
 * There was no evaluation harness of any kind: no dataset, no scorer, no
 * judge, no trajectory assertion. So every behavior change in this SDK —
 * a tool description, the `search_tools` top-k, the compaction threshold —
 * shipped with no regression signal behind it, and the only way to notice
 * a degradation was for a user to hit it.
 *
 * The scorer contract requires a `reason` on every score, so a report says
 * what got worse rather than only that something did.
 */
export async function runExperiment<TInput>(
	config: ExperimentConfig<TInput>,
): Promise<ExperimentReport> {
	const startedAt = Date.now()
	const threshold = config.passThreshold ?? 1
	const concurrency = Math.max(1, config.concurrency ?? 1)
	const timeoutMs = validateCaseTimeoutMs(config.timeoutMs)

	const results: CaseResult[] = new Array(config.cases.length)
	let cursor = 0

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++
			const evalCase = config.cases[index]
			if (!evalCase) return

			const result = await evaluateCase(config, evalCase, threshold, timeoutMs)
			results[index] = result
			config.onCaseFinish?.(result)
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, config.cases.length) }, worker))

	const settled = results.filter(Boolean)
	// An inconclusive case has no mean to contribute; averaging its zero in
	// would report a suite-wide regression caused by the harness.
	const scored = settled.filter((r) => r.status !== 'inconclusive')
	const mean = scored.length === 0 ? 0 : scored.reduce((sum, r) => sum + r.mean, 0) / scored.length

	return {
		name: config.name,
		cases: settled,
		mean,
		// Over the same cases the mean is over. Computing spread across a
		// different denominator than the average it qualifies would produce
		// an interval that does not belong to the number beside it.
		uncertainty: uncertaintyOf(scored.map((r) => r.mean)),
		passed: settled.filter((r) => r.status === 'passed').length,
		failed: settled.filter((r) => r.status === 'failed').length,
		inconclusive: settled.filter((r) => r.status === 'inconclusive').length,
		byScorer: meanByScorer(settled),
		durationMs: Date.now() - startedAt,
	}
}

function validateCaseTimeoutMs(value: number | undefined): number | undefined {
	if (value === undefined) return undefined
	if (!Number.isInteger(value) || value < 1 || value > MAX_CASE_TIMEOUT_MS) {
		throw new RangeError(
			`timeoutMs must be an integer from 1 to ${MAX_CASE_TIMEOUT_MS}, or omitted; received ${String(value)}`,
		)
	}
	return value
}

interface CaseDeadline {
	readonly signal: AbortSignal
	race<T>(work: Promise<T>): Promise<T>
	dispose(): void
}

/** One wall-clock budget shared by execution and every scorer for a case. */
function openCaseDeadline(timeoutMs: number | undefined): CaseDeadline {
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	let expiry: Promise<never> | undefined
	let onAbort: (() => void) | undefined

	if (timeoutMs !== undefined && timeoutMs > 0) {
		expiry = new Promise<never>((_resolve, reject) => {
			onAbort = () => reject(controller.signal.reason)
			controller.signal.addEventListener('abort', onAbort, { once: true })
		})
		// A case can settle just before its timer. Keep the deadline promise
		// observed independently so a same-tick expiry cannot become an
		// unhandled rejection while the scope is being disposed.
		void expiry.catch(() => {})
		timer = setTimeout(
			() => controller.abort(new Error(`case timed out after ${timeoutMs}ms`)),
			timeoutMs,
		)
	}

	return {
		signal: controller.signal,
		async race<T>(work: Promise<T>): Promise<T> {
			if (!expiry) return await work
			// A non-cooperative run or scorer may reject after the deadline won.
			// Observe that loser without making suite settlement depend on it.
			void work.catch(() => {})
			return await Promise.race([work, expiry])
		},
		dispose() {
			clearTimeout(timer)
			if (onAbort) controller.signal.removeEventListener('abort', onAbort)
		},
	}
}

async function evaluateCase<TInput>(
	config: ExperimentConfig<TInput>,
	evalCase: EvalCase<TInput>,
	threshold: number,
	timeoutMs: number | undefined,
): Promise<CaseResult> {
	const deadline = openCaseDeadline(timeoutMs)
	try {
		const run = await executeCase(config, evalCase, deadline)
		const scorers = evalCase.scorers ?? config.scorers
		const scores: Record<string, Score> = {}

		// Scores are keyed by name, so two scorers sharing one collapse:
		// the mean's denominator becomes the count of distinct NAMES and
		// the surviving score is whichever ran last. Two
		// `containsScorer(...)` instances are both called 'contains', so
		// this is easy to hit by accident and silently halves the
		// evidence. Ambiguous results are worse than a loud failure.
		const seen = new Set<string>()
		for (const scorer of scorers) {
			if (seen.has(scorer.name)) {
				throw new Error(
					`Duplicate scorer name "${scorer.name}" for case "${evalCase.name}". Scores are keyed by name, so the second would overwrite the first and the case mean would be computed over the wrong denominator. Give each scorer a distinct name.`,
				)
			}
			seen.add(scorer.name)
			scores[scorer.name] = await safeScore(scorer, run, evalCase, deadline)
		}

		// Only scores that were actually produced count — an unavailable
		// scorer leaves the denominator alone rather than dragging the
		// mean toward zero with a measurement that never happened.
		const values = Object.values(scores)
			.filter((s) => s.unavailable !== true)
			.map((s) => s.score)
		const mean = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length

		// A gate miss fails the case whatever the mean says. Averaging a
		// hard check together with a fuzzy one lets three good scores
		// carry a zero: trajectory 0 + completion 1 + contains 1 +
		// judge 1 averages to 0.75 and reports passed at a threshold of
		// 0.75 — the exact regression the harness exists to catch,
		// reported green. An UNAVAILABLE gate does not fail the case;
		// it did not judge the run at all, which is the inconclusive
		// path, not a failure.
		const failedGates = scorers
			.filter((s) => s.severity === 'gate')
			.filter((s) => {
				const score = scores[s.name]
				if (!score || score.unavailable === true) return false
				return score.score < (s.threshold ?? threshold)
			})
			.map((s) => s.name)

		const status: CaseStatus =
			Object.keys(scores).length > 0 && values.length === 0
				? 'inconclusive'
				: failedGates.length > 0
					? 'failed'
					: mean >= threshold
						? 'passed'
						: 'failed'
		return {
			case: evalCase.name,
			run,
			scores,
			mean,
			status,
			passed: status === 'passed',
			// Named, not just counted: "failed" with a mean of 0.75 sends
			// somebody to read four scores and guess which one mattered.
			...(failedGates.length > 0 ? { failedGates } : {}),
		}
	} finally {
		deadline.dispose()
	}
}

/**
 * A case that throws is a RESULT, not a crash. An eval suite whose first
 * broken case aborts the run tells you nothing about the other forty.
 */
async function executeCase<TInput>(
	config: ExperimentConfig<TInput>,
	evalCase: EvalCase<TInput>,
	deadline: CaseDeadline,
): Promise<EvalRun> {
	const startedAt = Date.now()
	try {
		const work = config.run(evalCase.input, evalCase, deadline.signal)
		return await deadline.race(work)
	} catch (err) {
		return {
			output: null,
			steps: [],
			toolCalls: [],
			totalTokens: 0,
			totalCostUsd: 0,
			// Real elapsed time, not zero: a case that burned its whole
			// deadline is the most interesting number in the report, and
			// zero would hide it.
			durationMs: Date.now() - startedAt,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/** A throwing scorer scores zero with the throw as its reason. */
async function safeScore(
	scorer: Scorer,
	run: EvalRun,
	evalCase: EvalCase,
	deadline: CaseDeadline,
): Promise<Score> {
	// A run that THREW scores zero, whatever the scorer would have said.
	// `executeCase` catches the failure and returns an empty run, and an
	// empty run walks straight into every scorer's happy path:
	// `stepBudgetScorer` sees 0 steps against its allowance and returns 1,
	// `trajectoryScorer` sees no tools expected and none called and returns
	// 1. So a suite whose runs were all dying reported green. The failure is
	// recorded on `run.error` and nothing consulted it.
	if (run.error !== undefined) {
		return { score: 0, reason: `run failed: ${run.error}`, details: { error: run.error } }
	}

	try {
		deadline.signal.throwIfAborted()
		// Defer invocation into the promise so a synchronous scorer throw is
		// raced and observed by the same path as an asynchronous rejection.
		const work = Promise.resolve().then(() => scorer.score(run, evalCase, deadline.signal))
		return await deadline.race(work)
	} catch (err) {
		// UNAVAILABLE, not zero. A scorer that threw did not judge the run
		// badly — it failed to judge it at all, and the two call for
		// opposite responses. Scoring the throw zero was survivable while
		// every scorer was a pure function; a scorer that reaches a provider
		// makes it actively misleading, because one rate limit would look
		// exactly like a behavioural regression.
		return {
			score: 0,
			unavailable: true,
			reason: `scorer "${scorer.name}" could not judge this run: ${
				err instanceof Error ? err.message : String(err)
			}`,
		}
	}
}

function meanByScorer(results: readonly CaseResult[]): Record<string, number> {
	const sums = new Map<string, { total: number; count: number }>()
	for (const result of results) {
		for (const [name, score] of Object.entries(result.scores)) {
			if (score.unavailable === true) continue
			const entry = sums.get(name) ?? { total: 0, count: 0 }
			entry.total += score.score
			entry.count++
			sums.set(name, entry)
		}
	}
	const out: Record<string, number> = {}
	// A scorer that was never available anywhere is omitted rather than
	// reported as 0 — a dimension with no measurements is not a dimension
	// that scored badly.
	for (const [name, { total, count }] of sums) {
		if (count > 0) out[name] = total / count
	}
	return out
}

/**
 * Render a report as text.
 *
 * Failures print their scorer reasons, because a CI log that says
 * "0.62" is a log that sends someone back to reproduce it by hand.
 */
/**
 * Uncertainty for a report that did not carry its own.
 *
 * A suite file is loaded at runtime and may be plain JavaScript, so a
 * report can reach here hand-built — the type cannot stop it. Deriving
 * from the cases it does carry is better than either alternative:
 * printing the mean alone leaves the reader where they started, and
 * refusing to format would turn a missing convenience into a broken
 * command.
 *
 * Uses the same exclusion `runExperiment` uses, so a derived interval and
 * a carried one are the same number rather than two conventions.
 */
function derivedUncertainty(report: ExperimentReport): ScoreUncertainty {
	return uncertaintyOf(report.cases.filter((c) => c.status !== 'inconclusive').map((c) => c.mean))
}

export function formatReport(report: ExperimentReport): string {
	const lines: string[] = [
		`${report.name}: ${report.passed}/${report.cases.length} passed (mean ${report.mean.toFixed(2)}) in ${report.durationMs}ms`,
		// On its own line and always printed, including when the interval is
		// undefined. A mean printed alone is the thing that has been
		// over-read: two runs three points apart look like a difference, and
		// at the n a hand-built suite has they are usually the same run
		// twice. Computing the interval and not showing it would leave the
		// reader exactly where they started.
		`  ${describeUncertainty(report.mean, report.uncertainty ?? derivedUncertainty(report))}`,
		'',
	]

	// Surfaced above the failures, because an inconclusive case means the
	// harness is broken and every number below it is measured over less
	// evidence than it looks like.
	if (report.inconclusive > 0) {
		lines.push(
			`  ${report.inconclusive} case${report.inconclusive === 1 ? '' : 's'} could not be judged — the numbers below cover the rest`,
			'',
		)
	}

	for (const [name, mean] of Object.entries(report.byScorer)) {
		lines.push(`  ${name}: ${mean.toFixed(2)}`)
	}

	const failures = report.cases.filter((c) => c.status === 'failed')
	if (failures.length > 0) {
		lines.push('', 'Failures:')
		for (const failure of failures) {
			lines.push(`  ✗ ${failure.case} (${failure.mean.toFixed(2)})`)
			if (failure.failedGates && failure.failedGates.length > 0) {
				// First line under the case, because it says WHY this failed.
				// A mean of 0.75 next to four scores leaves the reader
				// guessing which one mattered.
				lines.push(`      gate missed: ${failure.failedGates.join(', ')}`)
			}
			for (const [name, score] of Object.entries(failure.scores)) {
				if (score.unavailable === true) {
					lines.push(`      ${name}: not judged — ${score.reason}`)
				} else if (score.score < 1) {
					lines.push(`      ${name}: ${score.reason}`)
				}
			}
			if (failure.run.error) lines.push(`      error: ${failure.run.error}`)
		}
	}

	const unjudged = report.cases.filter((c) => c.status === 'inconclusive')
	if (unjudged.length > 0) {
		lines.push('', 'Not judged:')
		for (const item of unjudged) {
			lines.push(`  ? ${item.case}`)
			for (const [name, score] of Object.entries(item.scores)) {
				lines.push(`      ${name}: ${score.reason}`)
			}
		}
	}

	return lines.join('\n')
}
