import type { CaseResult, EvalCase, EvalRun, ExperimentReport, Score, Scorer } from './types.js'

export interface ExperimentConfig<TInput = unknown> {
	name: string
	cases: ReadonlyArray<EvalCase<TInput>>
	/** Applied to every case unless the case overrides them. */
	scorers: readonly Scorer[]
	/**
	 * Execute one case. Returning an `EvalRun` rather than driving `query()`
	 * here keeps the harness independent of how you construct a run —
	 * scripted mock, real provider, or a whole agent behind a facade.
	 */
	run: (input: TInput, evalCase: EvalCase<TInput>) => Promise<EvalRun>
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

	const results: CaseResult[] = new Array(config.cases.length)
	let cursor = 0

	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor++
			const evalCase = config.cases[index]
			if (!evalCase) return

			const run = await executeCase(config, evalCase)
			const scorers = evalCase.scorers ?? config.scorers
			const scores: Record<string, Score> = {}

			for (const scorer of scorers) {
				scores[scorer.name] = await safeScore(scorer, run, evalCase)
			}

			const values = Object.values(scores).map((s) => s.score)
			const mean = values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
			const result: CaseResult = {
				case: evalCase.name,
				run,
				scores,
				mean,
				passed: mean >= threshold,
			}
			results[index] = result
			config.onCaseFinish?.(result)
		}
	}

	await Promise.all(Array.from({ length: Math.min(concurrency, config.cases.length) }, worker))

	const settled = results.filter(Boolean)
	const mean =
		settled.length === 0 ? 0 : settled.reduce((sum, r) => sum + r.mean, 0) / settled.length

	return {
		name: config.name,
		cases: settled,
		mean,
		passed: settled.filter((r) => r.passed).length,
		failed: settled.filter((r) => !r.passed).length,
		byScorer: meanByScorer(settled),
		durationMs: Date.now() - startedAt,
	}
}

/**
 * A case that throws is a RESULT, not a crash. An eval suite whose first
 * broken case aborts the run tells you nothing about the other forty.
 */
async function executeCase<TInput>(
	config: ExperimentConfig<TInput>,
	evalCase: EvalCase<TInput>,
): Promise<EvalRun> {
	try {
		return await config.run(evalCase.input, evalCase)
	} catch (err) {
		return {
			output: null,
			steps: [],
			toolCalls: [],
			totalTokens: 0,
			totalCostUsd: 0,
			durationMs: 0,
			error: err instanceof Error ? err.message : String(err),
		}
	}
}

/** A throwing scorer scores zero with the throw as its reason. */
async function safeScore(scorer: Scorer, run: EvalRun, evalCase: EvalCase): Promise<Score> {
	try {
		return await scorer.score(run, evalCase)
	} catch (err) {
		return {
			score: 0,
			reason: `scorer "${scorer.name}" threw: ${err instanceof Error ? err.message : String(err)}`,
		}
	}
}

function meanByScorer(results: readonly CaseResult[]): Record<string, number> {
	const sums = new Map<string, { total: number; count: number }>()
	for (const result of results) {
		for (const [name, score] of Object.entries(result.scores)) {
			const entry = sums.get(name) ?? { total: 0, count: 0 }
			entry.total += score.score
			entry.count++
			sums.set(name, entry)
		}
	}
	const out: Record<string, number> = {}
	for (const [name, { total, count }] of sums) out[name] = total / count
	return out
}

/**
 * Render a report as text.
 *
 * Failures print their scorer reasons, because a CI log that says
 * "0.62" is a log that sends someone back to reproduce it by hand.
 */
export function formatReport(report: ExperimentReport): string {
	const lines: string[] = [
		`${report.name}: ${report.passed}/${report.cases.length} passed (mean ${report.mean.toFixed(2)}) in ${report.durationMs}ms`,
		'',
	]

	for (const [name, mean] of Object.entries(report.byScorer)) {
		lines.push(`  ${name}: ${mean.toFixed(2)}`)
	}

	const failures = report.cases.filter((c) => !c.passed)
	if (failures.length > 0) {
		lines.push('', 'Failures:')
		for (const failure of failures) {
			lines.push(`  ✗ ${failure.case} (${failure.mean.toFixed(2)})`)
			for (const [name, score] of Object.entries(failure.scores)) {
				if (score.score < 1) lines.push(`      ${name}: ${score.reason}`)
			}
			if (failure.run.error) lines.push(`      error: ${failure.run.error}`)
		}
	}

	return lines.join('\n')
}
