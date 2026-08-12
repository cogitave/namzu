/**
 * How much of a score is signal.
 *
 * A suite reported a mean and nothing else, so two runs differing by three
 * points read as a difference. At the n a hand-built suite has, that is
 * usually noise, and there was no number on the page that would have said
 * so.
 *
 * Evan Miller, "Adding Error Bars to Evals" (arXiv:2411.00640), is the
 * reference. Two of its results shape what is and is not computed here.
 */

/**
 * Two-sided 95% critical values of Student's t, by degrees of freedom.
 *
 * The normal approximation (1.96) is what most harnesses use and it is
 * wrong in the direction that matters: at n=5 the true multiplier is 2.78,
 * so a normal interval is nearly 30% too narrow exactly where a suite is
 * small enough for that to mislead. Eval suites are small; this table is
 * the difference between an interval that covers and one that flatters.
 */
const T_95: readonly number[] = [
	12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145,
	2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048,
	2.045, 2.042,
]

function critical95(df: number): number {
	if (df < 1) return Number.NaN
	// Beyond 30 the t value is within ~1% of the normal, and pretending
	// otherwise would imply a precision the rest of this does not have.
	return T_95[df - 1] ?? 1.96
}

export interface ScoreUncertainty {
	/** Cases that produced a score. Not the number of cases run. */
	readonly n: number
	/** Sample standard deviation, Bessel-corrected. */
	readonly stdDev: number
	/** Standard error of the mean. */
	readonly stdError: number
	/** Half-width of the 95% interval: the mean plus or minus this. */
	readonly margin95: number
	/**
	 * The 95% interval, clamped to the score range.
	 *
	 * Clamped because a mean of 0.95 with a wide interval otherwise reports
	 * an upper bound above 1, which is not a possible score and makes a
	 * reader distrust the whole figure. The clamp is cosmetic and the
	 * margin above is not — read that one for the width.
	 */
	readonly ci95: readonly [low: number, high: number]
	/**
	 * True when there is not enough data for an interval at all.
	 *
	 * One case has no spread to measure. Reporting `±0` there would be the
	 * most confident-looking output the suite can produce, from the least
	 * evidence it can have.
	 */
	readonly undefinedInterval: boolean
}

/**
 * Spread of a set of scores, with the interval a reader should apply.
 *
 * **Assumes the cases are independent, and they may not be.** Miller's
 * clustered standard errors run up to 3x the naive figure when cases come
 * in related groups — several cases derived from one scenario, or one
 * document, or one seed. This harness has no grouping key on a case, so
 * there is nothing here to cluster on and this returns the naive figure.
 * Where a suite does build several cases from one source, treat the
 * interval below as a floor rather than as the answer.
 *
 * Stated rather than silently assumed because a too-narrow interval is
 * worse than none: it turns "we cannot tell" into a number that looks
 * like we can.
 */
export function uncertaintyOf(scores: readonly number[]): ScoreUncertainty {
	const n = scores.length
	if (n < 2) {
		return {
			n,
			stdDev: 0,
			stdError: 0,
			margin95: Number.NaN,
			ci95: [Number.NaN, Number.NaN],
			undefinedInterval: true,
		}
	}

	const mean = scores.reduce((a, b) => a + b, 0) / n
	// Bessel-corrected: dividing by n estimates the spread of THESE cases,
	// and the question is about the suite they were drawn from.
	const variance = scores.reduce((acc, s) => acc + (s - mean) ** 2, 0) / (n - 1)
	const stdDev = Math.sqrt(variance)
	const stdError = stdDev / Math.sqrt(n)
	const margin95 = critical95(n - 1) * stdError

	return {
		n,
		stdDev,
		stdError,
		margin95,
		ci95: [Math.max(0, mean - margin95), Math.min(1, mean + margin95)],
		undefinedInterval: false,
	}
}

/**
 * One line a reader can act on, for a surface that prints a score.
 *
 * Names the interval rather than only the mean, because the mean alone is
 * the thing that has been over-read. An interval spanning most of the
 * scale says the suite cannot currently tell two runs apart, and that is
 * the most useful sentence such a suite can produce.
 */
export function describeUncertainty(mean: number, u: ScoreUncertainty): string {
	if (u.undefinedInterval) {
		return u.n === 0
			? 'no scored cases, so no score'
			: `${mean.toFixed(3)} from a single case — no interval, and one case cannot show spread`
	}
	return `${mean.toFixed(3)} ±${u.margin95.toFixed(3)} (95% CI ${u.ci95[0].toFixed(3)}–${u.ci95[1].toFixed(3)}, n=${u.n}); assumes cases are independent`
}
