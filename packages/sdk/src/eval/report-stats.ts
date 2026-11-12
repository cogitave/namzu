import { type CaseIntervals, type CaseTally, bootstrapCases } from './bootstrap.js'
import type { CaseRepeatSummary, CaseResult, EvalSplit } from './types.js'

/**
 * The numbers a report carries about a set of runs, whether that set is one
 * suite, one split of it, or every suite in a run.
 *
 * Cases are the unit. A case with several repeats is one case with several
 * runs: the pass rate pools the runs, the intervals resample the cases, and
 * reliability asks of each case whether it held up every time.
 */

export interface RepeatReliability {
	/** Cases that ran. */
	cases: number
	/** Cases whose every repeat passed. */
	passedEveryRepeat: number
	/** `passedEveryRepeat / cases`; null when no case ran. */
	fraction: number | null
}

export interface SplitSummary {
	cases: number
	runs: number
	passed: number
	failed: number
	inconclusive: number
	passRate: number | null
	mean: number | null
	intervals: CaseIntervals
}

/** The runs of one case, with the key that pairs it with the same case elsewhere. */
export interface CaseRuns {
	readonly key: string
	readonly name: string
	readonly split?: EvalSplit
	readonly runs: readonly CaseResult[]
}

export interface RunStats {
	cases: number
	runs: number
	passed: number
	failed: number
	inconclusive: number
	passRate: number | null
	mean: number | null
	intervals: CaseIntervals
	caseSummaries: CaseRepeatSummary[]
	reliability: RepeatReliability
	splits: Partial<Record<EvalSplit | 'unassigned', SplitSummary>>
}

export const SPLIT_ORDER = ['development', 'held-out', 'unassigned'] as const

/** Group a flat list of runs by case name, in the order the cases first appear. */
export function groupRuns(
	results: readonly CaseResult[],
	keyOf: (name: string) => string = (name) => name,
): CaseRuns[] {
	const groups = new Map<string, { name: string; split?: EvalSplit; runs: CaseResult[] }>()
	for (const run of results) {
		const key = keyOf(run.case)
		let group = groups.get(key)
		if (!group) {
			group = { name: run.case, ...(run.split ? { split: run.split } : {}), runs: [] }
			groups.set(key, group)
		}
		group.runs.push(run)
	}
	return [...groups].map(([key, g]) => ({ key, ...g }))
}

/** The first name that appears more than once, or undefined. */
export function duplicateName(names: readonly string[]): string | undefined {
	const seen = new Set<string>()
	for (const name of names) {
		if (seen.has(name)) return name
		seen.add(name)
	}
	return undefined
}

export function duplicateMessage(suite: string, name: string): string {
	return `suite "${suite}" has the case "${name}" more than once; a case is named by its id, and two cases sharing one would be merged into one in every count and interval. Give each case its own name.`
}

/**
 * The first case in a list of runs that appears twice for the same repeat: a
 * second run of a case is a repeat only when it says it is a later one.
 */
export function duplicateRun(
	runs: readonly Pick<CaseResult, 'case' | 'repeat'>[],
): string | undefined {
	const seen = new Set<string>()
	for (const run of runs) {
		const key = `${run.case}\u0000${run.repeat ?? 1}`
		if (seen.has(key)) return run.case
		seen.add(key)
	}
	return undefined
}

/** Status of a run, tolerating a report old enough to carry only `passed`. */
export function statusOf(run: Pick<CaseResult, 'status' | 'passed'>): CaseResult['status'] {
	if (run.status === 'passed' || run.status === 'failed' || run.status === 'inconclusive') {
		return run.status
	}
	return run.passed === true ? 'passed' : 'failed'
}

export function tallyOf(runs: readonly CaseResult[]): CaseTally | null {
	let scoreSum = 0
	let passes = 0
	let judged = 0
	for (const run of runs) {
		const status = statusOf(run)
		if (status === 'inconclusive') continue
		judged++
		scoreSum += run.mean
		if (status === 'passed') passes++
	}
	return judged === 0 ? null : { scoreSum, passes, judged }
}

/** True when the case has at least one judged run and every run passed. */
export function passedEveryRun(runs: readonly CaseResult[]): boolean {
	return runs.length > 0 && runs.every((run) => statusOf(run) === 'passed')
}

function summaryOf(runs: readonly CaseResult[]) {
	let passed = 0
	let failed = 0
	let inconclusive = 0
	for (const run of runs) {
		const status = statusOf(run)
		if (status === 'passed') passed++
		else if (status === 'failed') failed++
		else inconclusive++
	}
	return { passed, failed, inconclusive }
}

function numbersOver(cases: readonly CaseRuns[], seed: number) {
	const tallies: CaseTally[] = []
	let runs = 0
	for (const c of cases) {
		runs += c.runs.length
		const tally = tallyOf(c.runs)
		if (tally) tallies.push(tally)
	}
	const counts = summaryOf(cases.flatMap((c) => c.runs))
	const judged = counts.passed + counts.failed
	const scoreSum = tallies.reduce((sum, t) => sum + t.scoreSum, 0)
	return {
		runs,
		...counts,
		passRate: judged === 0 ? null : counts.passed / judged,
		mean: judged === 0 ? null : scoreSum / judged,
		intervals: bootstrapCases(tallies, seed),
	}
}

export function statsOver(cases: readonly CaseRuns[], seed: number): RunStats {
	const whole = numbersOver(cases, seed)
	const caseSummaries: CaseRepeatSummary[] = cases.map((c) => {
		const counts = summaryOf(c.runs)
		const tally = tallyOf(c.runs)
		return {
			case: c.name,
			...(c.split ? { split: c.split } : {}),
			repeats: c.runs.length,
			...counts,
			mean: tally ? tally.scoreSum / tally.judged : null,
			passedEveryRepeat: passedEveryRun(c.runs),
		}
	})
	const everyRepeat = caseSummaries.filter((c) => c.passedEveryRepeat).length

	const splits: RunStats['splits'] = {}
	for (const name of SPLIT_ORDER) {
		const members = cases.filter((c) => (c.split ?? 'unassigned') === name)
		if (members.length === 0) continue
		const part = numbersOver(members, seed)
		splits[name] = { cases: members.length, ...part }
	}

	return {
		cases: cases.length,
		...whole,
		caseSummaries,
		reliability: {
			cases: cases.length,
			passedEveryRepeat: everyRepeat,
			fraction: cases.length === 0 ? null : everyRepeat / cases.length,
		},
		splits,
	}
}

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
const score = (value: number): string => value.toFixed(3)

/**
 * The intervals, as lines a person reads next to the numbers. A number whose
 * interval is not computed is printed with the reason, never alone.
 */
export function describeIntervals(args: {
	mean: number | null
	passRate: number | null
	intervals: CaseIntervals
}): string[] {
	const { intervals } = args
	const line = (
		label: string,
		estimate: number | null,
		interval: CaseIntervals['mean'],
		show: (n: number) => string,
	): string => {
		if (estimate === null) return `${label}: none, no run was judged`
		if (!interval.computed) return `${label} ${show(estimate)}, no interval: ${interval.reason}`
		return `${label} ${show(estimate)}, 95% interval ${show(interval.low)} to ${show(interval.high)}`
	}
	const lines = [
		line('mean score', args.mean, intervals.mean, score),
		line('pass rate', args.passRate, intervals.passRate, percent),
	]
	if (intervals.mean.computed || intervals.passRate.computed) {
		lines.push(
			`intervals: ${intervals.method.kind} (${intervals.method.cases} cases, ${intervals.method.resamples} resamples), seed ${intervals.method.seed}`,
		)
	}
	return lines
}

/** The line that says which splits a suite has, and says so plainly when none is held out. */
export function describeSplits(splits: RunStats['splits']): string[] {
	const lines: string[] = []
	// A suite that declares no split has one bucket and nothing to break down.
	const declared = SPLIT_ORDER.some((name) => name !== 'unassigned' && splits[name])
	for (const name of SPLIT_ORDER) {
		const part = splits[name]
		if (!part || !declared) continue
		const rate = part.passRate === null ? 'no judged run' : `pass rate ${percent(part.passRate)}`
		const interval = part.intervals.passRate.computed
			? `, 95% interval ${percent(part.intervals.passRate.low)} to ${percent(part.intervals.passRate.high)}`
			: ''
		lines.push(`${name}: ${part.cases} case${part.cases === 1 ? '' : 's'}, ${rate}${interval}`)
	}
	if (!splits['held-out']) {
		lines.push(
			'no held-out cases: every number here is measured on cases the suite was developed against',
		)
	}
	return lines
}
