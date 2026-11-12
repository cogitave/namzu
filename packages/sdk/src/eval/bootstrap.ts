/**
 * Intervals for an eval, by resampling cases.
 *
 * A pass rate printed alone invites conclusions the data cannot carry: on 80
 * tasks a difference of -1.25 points came with a 95% interval from -10.0 to
 * +7.5, which says almost nothing. The interval here is a percentile
 * bootstrap over CASES. A case is the unit that was sampled from the world, so
 * a case is what gets resampled, and all of a case's repeats travel with it:
 * repeats of one case are not independent evidence about the suite, and
 * treating them as such would narrow the interval for free.
 *
 * Nothing in here reads the clock or an unseeded random source. The generator
 * is a small deterministic one fed by a seed that the report records, so the
 * same cases and the same seed give the same interval.
 */

/** Fewest cases an interval is computed for. Below it the report says why. */
export const MIN_CASES_FOR_INTERVAL = 5

/** Resamples drawn per interval. */
export const BOOTSTRAP_RESAMPLES = 2000

/** The seed used when none is given. A fixed number, so a report is reproducible. */
export const DEFAULT_EVAL_SEED = 1

/** Coverage of every interval in this module. */
export const INTERVAL_LEVEL = 0.95

/**
 * What one case contributes: the sum of its judged runs' scores, how many of
 * those runs passed, and how many were judged at all. `judged` is at least 1;
 * a case with no judged run has nothing to say and is left out by the caller.
 */
export interface CaseTally {
	readonly scoreSum: number
	readonly passes: number
	readonly judged: number
}

/**
 * An interval, or the reason there is none.
 *
 * `estimate` is the number the interval is around, and is present even when
 * no interval is computed, so a reader always has the point value and the
 * explanation for why it carries no bounds.
 */
export type Interval =
	| {
			readonly computed: true
			readonly estimate: number
			readonly low: number
			readonly high: number
	  }
	| {
			readonly computed: false
			readonly estimate: number | null
			readonly reason: string
	  }

/** The method and its settings, written next to the numbers so they can be reproduced. */
export interface BootstrapMethod {
	readonly kind: 'percentile bootstrap over cases, repeats kept together'
	readonly level: typeof INTERVAL_LEVEL
	readonly resamples: number
	readonly seed: number
	/** Cases the interval was drawn over. */
	readonly cases: number
	readonly minimumCases: number
}

export interface CaseIntervals {
	readonly method: BootstrapMethod
	/** Mean score over judged runs. */
	readonly mean: Interval
	/** Passed runs over judged runs. */
	readonly passRate: Interval
}

/** The same for a paired difference, second side minus first. */
export interface DifferenceIntervals {
	readonly method: BootstrapMethod
	readonly mean: Interval
	readonly passRate: Interval
}

/**
 * Validate a seed: an integer that fits in 32 bits, unsigned.
 * Thrown as a RangeError so a CLI can turn it into a usage error.
 */
export function validateSeed(value: number | undefined): number {
	if (value === undefined) return DEFAULT_EVAL_SEED
	if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
		throw new RangeError(
			`seed must be an integer from 0 to 4294967295, or omitted; received ${String(value)}`,
		)
	}
	return value
}

/**
 * mulberry32: a 32-bit generator with one word of state. Not for secrets;
 * its job is to be the same on every machine for a given seed.
 */
export function createSeededRandom(seed: number): () => number {
	let state = validateSeed(seed) >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

function quantile(sorted: Float64Array, p: number): number {
	const position = p * (sorted.length - 1)
	const lower = Math.floor(position)
	const upper = Math.ceil(position)
	const low = sorted[lower] as number
	const high = sorted[upper] as number
	return low + (high - low) * (position - lower)
}

/**
 * Draw `resamples` samples of `n` indices with replacement, hand each to
 * `statistics`, and return the 2.5th and 97.5th percentiles of the two numbers
 * it returns. Both statistics see the same draw, so the two intervals come
 * from one set of resampled suites.
 */
function bootstrap(
	n: number,
	seed: number,
	statistics: (draw: Int32Array) => readonly [number, number],
): { mean: [number, number]; passRate: [number, number] } {
	const random = createSeededRandom(seed)
	const draw = new Int32Array(n)
	const means = new Float64Array(BOOTSTRAP_RESAMPLES)
	const rates = new Float64Array(BOOTSTRAP_RESAMPLES)
	for (let b = 0; b < BOOTSTRAP_RESAMPLES; b++) {
		for (let i = 0; i < n; i++) draw[i] = Math.floor(random() * n)
		const [mean, rate] = statistics(draw)
		means[b] = mean
		rates[b] = rate
	}
	means.sort()
	rates.sort()
	const lowP = (1 - INTERVAL_LEVEL) / 2
	const highP = 1 - lowP
	return {
		mean: [quantile(means, lowP), quantile(means, highP)],
		passRate: [quantile(rates, lowP), quantile(rates, highP)],
	}
}

function methodOf(seed: number, cases: number): BootstrapMethod {
	return {
		kind: 'percentile bootstrap over cases, repeats kept together',
		level: INTERVAL_LEVEL,
		resamples: BOOTSTRAP_RESAMPLES,
		seed,
		cases,
		minimumCases: MIN_CASES_FOR_INTERVAL,
	}
}

function tooFew(one: string, many: string, n: number): string {
	return `only ${n} ${n === 1 ? one : many}; an interval needs at least ${MIN_CASES_FOR_INTERVAL}`
}

export function pooledMeanAndRate(
	tallies: readonly CaseTally[],
	draw?: Int32Array,
): [number, number] {
	let score = 0
	let passes = 0
	let judged = 0
	const count = draw ? draw.length : tallies.length
	for (let i = 0; i < count; i++) {
		const t = tallies[draw ? (draw[i] as number) : i] as CaseTally
		score += t.scoreSum
		passes += t.passes
		judged += t.judged
	}
	return judged === 0 ? [Number.NaN, Number.NaN] : [score / judged, passes / judged]
}

/**
 * 95% intervals for the mean score and the pass rate over a set of cases.
 *
 * Each resample draws as many cases as there are, with replacement, and pools
 * their runs. Cases without a judged run must not be passed in.
 */
export function bootstrapCases(tallies: readonly CaseTally[], seed: number): CaseIntervals {
	const checked = validateSeed(seed)
	const n = tallies.length
	const method = methodOf(checked, n)
	const [meanEstimate, rateEstimate] = n === 0 ? [null, null] : pooledMeanAndRate(tallies)
	if (n < MIN_CASES_FOR_INTERVAL) {
		const reason = tooFew('case with a judged run', 'cases with a judged run', n)
		return {
			method,
			mean: { computed: false, estimate: meanEstimate, reason },
			passRate: { computed: false, estimate: rateEstimate, reason },
		}
	}
	const result = bootstrap(n, checked, (draw) => pooledMeanAndRate(tallies, draw))
	return {
		method,
		mean: {
			computed: true,
			estimate: meanEstimate as number,
			low: result.mean[0],
			high: result.mean[1],
		},
		passRate: {
			computed: true,
			estimate: rateEstimate as number,
			low: result.passRate[0],
			high: result.passRate[1],
		},
	}
}

/** One case seen from both sides of a comparison. */
export interface PairedTally {
	readonly a: CaseTally
	readonly b: CaseTally
}

/**
 * 95% intervals for the difference of two runs over the same cases, `b` minus
 * `a`. A resample draws PAIRS, so the two sides of a case always travel
 * together; that is what makes the interval a paired one, and it is much
 * narrower than two separate intervals when the cases are the thing that
 * varies.
 */
export function bootstrapPairedDifference(
	pairs: readonly PairedTally[],
	seed: number,
): DifferenceIntervals {
	const checked = validateSeed(seed)
	const n = pairs.length
	const method = methodOf(checked, n)
	const aSide = pairs.map((p) => p.a)
	const bSide = pairs.map((p) => p.b)
	const difference = (draw?: Int32Array): [number, number] => {
		const [bMean, bRate] = pooledMeanAndRate(bSide, draw)
		const [aMean, aRate] = pooledMeanAndRate(aSide, draw)
		return [bMean - aMean, bRate - aRate]
	}
	const [meanEstimate, rateEstimate] = n === 0 ? [null, null] : difference()
	if (n < MIN_CASES_FOR_INTERVAL) {
		const reason = tooFew('paired case', 'paired cases', n)
		return {
			method,
			mean: { computed: false, estimate: meanEstimate, reason },
			passRate: { computed: false, estimate: rateEstimate, reason },
		}
	}
	const result = bootstrap(n, checked, (draw) => difference(draw))
	return {
		method,
		mean: {
			computed: true,
			estimate: meanEstimate as number,
			low: result.mean[0],
			high: result.mean[1],
		},
		passRate: {
			computed: true,
			estimate: rateEstimate as number,
			low: result.passRate[0],
			high: result.passRate[1],
		},
	}
}

/**
 * Exact two-sided sign test on discordant pairs: under no difference each flip
 * is equally likely to go either way, so the count going one way is
 * Binomial(n, 1/2). Returns twice the smaller tail, capped at 1; with no flips
 * at all the answer is 1.
 */
export function exactSignTestP(oneWay: number, otherWay: number): number {
	const n = oneWay + otherWay
	if (n === 0) return 1
	const k = Math.min(oneWay, otherWay)
	const logFactorial = new Float64Array(n + 1)
	for (let i = 2; i <= n; i++) logFactorial[i] = (logFactorial[i - 1] as number) + Math.log(i)
	let tail = 0
	for (let i = 0; i <= k; i++) {
		const logTerm =
			(logFactorial[n] as number) -
			(logFactorial[i] as number) -
			(logFactorial[n - i] as number) -
			n * Math.LN2
		tail += Math.exp(logTerm)
	}
	return Math.min(1, 2 * tail)
}
