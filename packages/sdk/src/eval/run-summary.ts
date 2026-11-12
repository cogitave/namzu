import { UNKNOWN } from './disclosure.js'
import type { RunMode } from './disclosure.js'
import {
	type RunStats,
	describeIntervals,
	describeSplits,
	groupRuns,
	statsOver,
} from './report-stats.js'
import type { SettingsSnapshot } from './settings.js'
import type { SplitFilter } from './split.js'
import type { ExperimentReport } from './types.js'

/** What produced a whole run, across every suite in it. */
export interface RunDisclosure {
	readonly harnessVersion: string
	readonly sdkVersion: string
	readonly generatedAt: string
	readonly commit: string
	readonly seed: number
	/** Repeats per case; the largest across suites when they differ. */
	readonly repeats: number
	readonly suites: number
	readonly cases: number
	readonly runs: number
	/** `mixed` when suites that used a model differ in kind; a suite with no model at all does not count. */
	readonly mode: RunMode | 'mixed'
	/** The settings the run was given. Absent from a run written before reports named them. */
	readonly settings?: SettingsSnapshot
	/** Which tasks ran. Absent from a run written before there were splits. */
	readonly split?: SplitFilter
}

/** The numbers for every case of every suite taken together. */
export interface RunSummary extends Omit<RunStats, 'caseSummaries' | 'reliability'> {
	readonly disclosure: RunDisclosure
	/** Present only when cases were repeated. */
	readonly reliability?: RunStats['reliability']
}

export function summarizeRun(
	entries: ReadonlyArray<{ suite: string; report: ExperimentReport }>,
	context: {
		seed: number
		harnessVersion: string
		commit: string
		generatedAt: string
		sdkVersion: string
		settings?: SettingsSnapshot
		split?: SplitFilter
	},
): RunSummary {
	// A case is named by its suite and its id: two suites may reuse a name.
	const cases = entries.flatMap(({ suite, report }) =>
		groupRuns(report.cases ?? [], (name) => `${suite}\u0000${name}`),
	)
	const { caseSummaries: _perCase, reliability, ...stats } = statsOver(cases, context.seed)
	const repeats = Math.max(1, ...entries.map((e) => e.report.repeats ?? 1))
	// A suite that used no model at all says nothing about whether a model
	// ran, so it does not make a run "mixed" with the suites that did.
	const all = entries.map((e) => e.report.disclosure?.mode ?? UNKNOWN)
	const modes = new Set(all.filter((m) => m !== 'no-model'))
	const mode: RunMode | 'mixed' =
		modes.size === 0
			? all.length === 0
				? UNKNOWN
				: 'no-model'
			: modes.size === 1
				? ([...modes][0] as RunMode)
				: 'mixed'
	return {
		...stats,
		...(repeats > 1 ? { reliability } : {}),
		disclosure: {
			harnessVersion: context.harnessVersion,
			sdkVersion: context.sdkVersion,
			generatedAt: context.generatedAt,
			commit: context.commit,
			seed: context.seed,
			repeats,
			suites: entries.length,
			cases: stats.cases,
			runs: stats.runs,
			mode,
			...(context.settings ? { settings: context.settings } : {}),
			...(context.split ? { split: context.split } : {}),
		},
	}
}

export function formatRunSummary(summary: RunSummary): string {
	const d = summary.disclosure
	const lines = [
		`Whole run: ${summary.passed}/${summary.runs} runs passed across ${d.suites} suite${d.suites === 1 ? '' : 's'}, ${summary.cases} case${summary.cases === 1 ? '' : 's'}${d.repeats > 1 ? ` x ${d.repeats} repeats` : ''}`,
	]
	for (const line of describeIntervals({
		mean: summary.mean,
		passRate: summary.passRate,
		intervals: summary.intervals,
	})) {
		lines.push(`  ${line}`)
	}
	if (summary.reliability) {
		const r = summary.reliability
		lines.push(
			`  reliability across repeats: ${r.passedEveryRepeat} of ${r.cases} cases passed in every one of ${d.repeats} repeats${r.fraction === null ? '' : ` (${(r.fraction * 100).toFixed(1)}%)`}`,
		)
	}
	for (const line of describeSplits(summary.splits)) {
		if (d.split === 'held-out' && line.startsWith('no held-out cases')) continue
		lines.push(`  ${line}`)
	}
	if (d.settings) {
		lines.push(`  settings: "${d.settings.name}", sha256 ${d.settings.digest.slice(0, 12)}`)
	}
	if (d.split) lines.push(`  split: ${d.split}`)
	lines.push(
		`  produced by: namzu eval ${d.harnessVersion}, sdk ${d.sdkVersion}, commit ${d.commit}, ${d.generatedAt}, ${d.mode}`,
	)
	return lines.join('\n')
}
