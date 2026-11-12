import type { HandBackKind } from '../types/session/hand-back.js'
import type { TurnOutcomeVerdict } from '../types/session/outcome.js'
import type { EvalCase, EvalTurn, Score, Scorer } from './types.js'

/**
 * Longest common subsequence length between two tool sequences.
 *
 * Subsequence, not set intersection: order carries meaning in a
 * trajectory. Reading a file before editing it is not the same turn as
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
 * How closely the turn's tool sequence matched the expected one, as F1 over
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
 * Extra calls cut precision, missing calls cut recall, so a turn that does
 * the right thing wastefully and a turn that skips a step score
 * differently — which is the distinction a final-answer score collapses.
 */
export function trajectoryScorer(): Scorer {
	return {
		name: 'trajectory',
		score(turn: EvalTurn, evalCase: EvalCase): Score {
			const expected = evalCase.expectedTools ?? []
			const actual = turn.toolCalls

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

/** The turn settled cleanly rather than erroring or being cut off. */
export function completionScorer(
	acceptable: readonly string[] = ['end_turn', 'stop_condition'],
): Scorer {
	return {
		name: 'completion',
		// Binary by construction: the turn either settled cleanly or it did
		// not, so there is no score between 0 and 1 for a mean to soften.
		// Averaged in, a hard 0 here is carried by three good fuzzy scores.
		severity: 'gate',
		score(turn: EvalTurn): Score {
			if (turn.error) {
				return { score: 0, reason: `turn failed: ${turn.error}` }
			}
			const ok = turn.stopReason !== undefined && acceptable.includes(turn.stopReason)
			return {
				score: ok ? 1 : 0,
				reason: ok
					? `settled as ${turn.stopReason}`
					: `settled as ${turn.stopReason ?? 'unknown'}, expected one of ${acceptable.join(', ')}`,
				details: { stopReason: turn.stopReason },
			}
		},
	}
}

/**
 * The turn stayed within a step budget.
 *
 * A regression that makes the agent take four turns where it took one is
 * invisible to correctness scoring and very visible on the bill.
 */
export function stepBudgetScorer(maxSteps: number): Scorer {
	return {
		name: 'step-budget',
		score(turn: EvalTurn): Score {
			const used = turn.steps.length
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
		// A required fragment is required. Partial credit here reads as
		// "most of the answer was there", which is not what was asked.
		severity: 'gate',
		score(turn: EvalTurn): Score {
			const text = turn.output ?? ''
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
 * The turn's outcome record has one of the given verdicts.
 *
 * Reads the record the kernel settled from what actually ran, not the answer's
 * words. A turn with no record scores unavailable: there is nothing to read,
 * which is not the same as a wrong verdict.
 */
export function outcomeScorer(verdicts: readonly TurnOutcomeVerdict[]): Scorer {
	return {
		name: 'outcome',
		// The record either says one of the verdicts or it does not.
		severity: 'gate',
		score(turn: EvalTurn): Score {
			const outcome = turn.outcome
			if (!outcome) {
				return { score: 0, unavailable: true, reason: 'the turn has no outcome record' }
			}
			const ok = verdicts.includes(outcome.verdict)
			return {
				score: ok ? 1 : 0,
				reason: ok
					? `verdict ${outcome.verdict}`
					: `verdict ${outcome.verdict}, expected one of ${verdicts.join(', ')}`,
				details: { verdict: outcome.verdict, expected: verdicts },
			}
		},
	}
}

/**
 * Whether the answer's plain check claims agree with the turn's outcome
 * record: 1 when `compareAnswerToOutcome` found no mismatch, 0 when it found
 * one, with the claim and what the record holds in the detail.
 *
 * Pass `{ expectMismatch: true }` for a case that is built to contradict
 * itself, so the suite proves the comparison fires as well as that it stays
 * silent.
 */
export function claimMismatchScorer(opts: { expectMismatch?: boolean } = {}): Scorer {
	const expectMismatch = opts.expectMismatch === true
	return {
		name: 'claim-mismatch',
		severity: 'gate',
		score(turn: EvalTurn): Score {
			const found = turn.claimMismatch
			const ok = expectMismatch ? found !== undefined : found === undefined
			return {
				score: ok ? 1 : 0,
				reason: found
					? `${found.said}, but the record: ${found.recordSays}`
					: 'no claim in the answer contradicts the record',
				details: { claimMismatch: found ?? null, expectMismatch },
			}
		},
	}
}

/**
 * Score whether the turn was handed back to a person.
 *
 * Pass `{ expectKind }` for a case built so the model hands the task back, and
 * the scorer checks it did, and for that kind; with nothing it checks the turn
 * was not handed back. A gate: a scripted suite pins the kernel's side of it.
 */
export function handedBackScorer(opts: { expectKind?: HandBackKind } = {}): Scorer {
	return {
		name: 'handed-back',
		severity: 'gate',
		score(turn: EvalTurn): Score {
			const found = turn.handedBack
			const ok =
				opts.expectKind === undefined ? found === undefined : found?.kind === opts.expectKind
			return {
				score: ok ? 1 : 0,
				reason: found ? `handed back (${found.kind}): ${found.blocker}` : 'not handed back',
				details: { handedBack: found ?? null, expectKind: opts.expectKind ?? null },
			}
		},
	}
}

/**
 * Judge the turn with a caller-supplied predicate.
 *
 * The escape hatch for anything the built-in scorers do not cover. For
 * a model-graded judge, reach for `judgeScorer` first: it handles the
 * parts that are easy to get wrong — a rubric it refuses to run without,
 * an ordinal scale rather than a float, disclosed truncation, and a
 * failed call that reports as unjudged rather than as a zero.
 */
export function customScorer(
	name: string,
	fn: (turn: EvalTurn, evalCase: EvalCase) => Score | Promise<Score>,
): Scorer {
	return { name, score: fn }
}
