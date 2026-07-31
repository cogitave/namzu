import type { EvalCase, EvalRun, Score, Scorer } from './types.js'

/**
 * Longest common subsequence length between two tool sequences.
 *
 * Subsequence, not set intersection: order carries meaning in a
 * trajectory. Reading a file before editing it is not the same run as
 * editing then reading, and a set-based score cannot tell them apart.
 */
function lcsLength(a: readonly string[], b: readonly string[]): number {
	const table: number[][] = Array.from({ length: a.length + 1 }, () =>
		new Array(b.length + 1).fill(0),
	)
	for (let i = 1; i <= a.length; i++) {
		for (let j = 1; j <= b.length; j++) {
			const row = table[i]
			const prev = table[i - 1]
			if (!row || !prev) continue
			row[j] =
				a[i - 1] === b[j - 1] ? (prev[j - 1] ?? 0) + 1 : Math.max(prev[j] ?? 0, row[j - 1] ?? 0)
		}
	}
	return table[a.length]?.[b.length] ?? 0
}

/**
 * How closely the run's tool sequence matched the expected one, as F1 over
 * the longest common subsequence.
 *
 * Trajectory, not final answer. Namzu's most load-bearing behavior is
 * tuned by constants nobody could measure — `search_tools` activates the
 * top 5 deferred tools, compaction fires at 0.7, six state lists cap at
 * 25 — and changing any of them, or a tool description, or the
 * deferred-tools prompt block, could silently make the agent take four
 * tool calls where it took one. Final-answer scoring cannot see that;
 * this can.
 *
 * Extra calls cut precision, missing calls cut recall, so a run that does
 * the right thing wastefully and a run that skips a step score
 * differently — which is the distinction a final-answer score collapses.
 */
export function trajectoryScorer(): Scorer {
	return {
		name: 'trajectory',
		score(run: EvalRun, evalCase: EvalCase): Score {
			const expected = evalCase.expectedTools ?? []
			const actual = run.toolCalls

			if (expected.length === 0 && actual.length === 0) {
				return { score: 1, reason: 'no tools expected and none called' }
			}
			if (expected.length === 0) {
				return {
					score: 0,
					reason: `expected no tool calls, got ${actual.length}: ${actual.join(' → ')}`,
					details: { actual },
				}
			}
			if (actual.length === 0) {
				return {
					score: 0,
					reason: `expected ${expected.join(' → ')}, but no tools were called`,
					details: { expected },
				}
			}

			const matched = lcsLength(expected, actual)
			const precision = matched / actual.length
			const recall = matched / expected.length
			const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)

			return {
				score: f1,
				reason:
					f1 === 1
						? `exact trajectory: ${actual.join(' → ')}`
						: `matched ${matched}/${expected.length} in order; expected ${expected.join(' → ')}, got ${actual.join(' → ')}`,
				details: { precision, recall, matched, expected, actual },
			}
		},
	}
}

/** The run settled cleanly rather than erroring or being cut off. */
export function completionScorer(
	acceptable: readonly string[] = ['end_turn', 'stop_condition'],
): Scorer {
	return {
		name: 'completion',
		score(run: EvalRun): Score {
			if (run.error) {
				return { score: 0, reason: `run failed: ${run.error}` }
			}
			const ok = run.stopReason !== undefined && acceptable.includes(run.stopReason)
			return {
				score: ok ? 1 : 0,
				reason: ok
					? `settled as ${run.stopReason}`
					: `settled as ${run.stopReason ?? 'unknown'}, expected one of ${acceptable.join(', ')}`,
				details: { stopReason: run.stopReason },
			}
		},
	}
}

/**
 * The run stayed within a step budget.
 *
 * A regression that makes the agent take four turns where it took one is
 * invisible to correctness scoring and very visible on the bill.
 */
export function stepBudgetScorer(maxSteps: number): Scorer {
	return {
		name: 'step-budget',
		score(run: EvalRun): Score {
			const used = run.steps.length
			return {
				score: used <= maxSteps ? 1 : Math.max(0, maxSteps / used),
				reason:
					used <= maxSteps
						? `${used}/${maxSteps} steps`
						: `over budget: ${used} steps against a ${maxSteps} allowance`,
				details: { used, maxSteps },
			}
		},
	}
}

/** The final text contains every required substring. */
export function containsScorer(...required: string[]): Scorer {
	return {
		name: 'contains',
		score(run: EvalRun): Score {
			const text = run.output ?? ''
			const missing = required.filter((r) => !text.includes(r))
			return {
				score: required.length === 0 ? 1 : (required.length - missing.length) / required.length,
				reason:
					missing.length === 0
						? `found all ${required.length} required fragments`
						: `missing: ${missing.join(', ')}`,
				details: { missing },
			}
		},
	}
}

/**
 * Judge the run with a caller-supplied predicate.
 *
 * The escape hatch for anything the built-in scorers do not cover —
 * including a model-graded judge, which is just an async predicate that
 * happens to call a provider.
 */
export function customScorer(
	name: string,
	fn: (run: EvalRun, evalCase: EvalCase) => Score | Promise<Score>,
): Scorer {
	return { name, score: fn }
}
