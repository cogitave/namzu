import {
	type CaseTally,
	type DifferenceIntervals,
	type Interval,
	type PairedTally,
	bootstrapPairedDifference,
	exactSignTestP,
	pooledMeanAndRate,
	validateSeed,
} from './bootstrap.js'
import { UNKNOWN } from './disclosure.js'
import { type CaseRuns, duplicateRun, groupRuns, passedEveryRun, tallyOf } from './report-stats.js'
import { type SettingDifference, diffSettings } from './settings.js'
import { SPLIT_FILTERS, type SplitFilter } from './split.js'
import type { CaseResult } from './types.js'

/**
 * Two eval reports, side by side, paired by suite and case id.
 *
 * Two pass rates a few points apart read as a difference, and at the size of
 * a hand-built suite they are usually not one. The comparison pairs the cases
 * both sides ran, takes the difference over those, and puts an interval on it
 * by resampling the pairs. It says "no difference can be claimed at this
 * size" whenever that interval includes zero, and it says what else differs
 * between the two runs, because a difference that comes with a new model and
 * a new harness version and a new effort cannot be credited to any of them.
 */

/** One suite of a loaded report file. */
export interface LoadedSuite {
	readonly id: string
	readonly cases: readonly CaseRuns[]
	readonly repeats: number
	/** Whatever the file said about how the suite ran; absent in an older file. */
	readonly facts: Readonly<Record<string, unknown>> | undefined
	/** The settings snapshot the suite ran under; absent in a report written before there were any. */
	readonly settings: LoadedSettings | undefined
	/** Which split the suite ran; absent in a report written before there were any. */
	readonly split: SplitFilter | undefined
}

export interface LoadedSettings {
	readonly name: string
	readonly digest: string
	readonly values: Readonly<Record<string, unknown>>
	/** False when the suite never asked for the settings. Absent is read as unknown. */
	readonly read: boolean | undefined
}

function loadSettings(value: unknown): LoadedSettings | undefined {
	if (!isRecord(value)) return undefined
	if (typeof value.name !== 'string' || typeof value.digest !== 'string') return undefined
	return {
		name: value.name,
		digest: value.digest,
		values: isRecord(value.values) ? value.values : {},
		read: typeof value.read === 'boolean' ? value.read : undefined,
	}
}

function loadSplit(value: unknown): SplitFilter | undefined {
	if (!isRecord(value)) return undefined
	return SPLIT_FILTERS.includes(value.requested as SplitFilter)
		? (value.requested as SplitFilter)
		: undefined
}

export interface LoadedReportFile {
	readonly label: string
	readonly suites: readonly LoadedSuite[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the JSON `namzu eval --out` writes. Tolerant of a file from an older
 * version: only `suites[].suite` and each case's name, mean and status are
 * required; repeats, splits and disclosure are read when they are there.
 * Throws an Error whose message names what is wrong, for a person to read.
 */
export function loadEvalReportFile(json: unknown, label: string): LoadedReportFile {
	if (!isRecord(json) || !Array.isArray(json.suites)) {
		throw new Error(`${label} is not an eval report: it has no "suites" list.`)
	}
	const suites: LoadedSuite[] = []
	for (const [index, entry] of json.suites.entries()) {
		if (!isRecord(entry) || typeof entry.suite !== 'string' || !isRecord(entry.report)) {
			throw new Error(`${label}: suites[${index}] needs a "suite" id and a "report".`)
		}
		const report = entry.report
		if (!Array.isArray(report.cases)) {
			throw new Error(`${label}: suite "${entry.suite}" has no "cases" list.`)
		}
		const runs: CaseResult[] = []
		for (const [caseIndex, run] of report.cases.entries()) {
			if (!isRecord(run) || typeof run.case !== 'string' || !Number.isFinite(run.mean)) {
				throw new Error(
					`${label}: suite "${entry.suite}", case ${caseIndex} needs a name in "case" and a finite number in "mean".`,
				)
			}
			runs.push(run as unknown as CaseResult)
		}
		const twice = duplicateRun(runs)
		if (twice !== undefined) {
			throw new Error(
				`${label}: suite "${entry.suite}" has the case "${twice}" more than once, so its runs cannot be told from one case's repeats. A case is named by its id; the report needs each case once per repeat.`,
			)
		}
		suites.push({
			id: entry.suite,
			cases: groupRuns(runs),
			repeats: typeof report.repeats === 'number' ? report.repeats : 1,
			facts: isRecord(report.disclosure) ? report.disclosure : undefined,
			settings: loadSettings(report.settings),
			split: loadSplit(report.taskSplit),
		})
	}
	return { label, suites }
}

// ─── what differs in how two reports were produced ───────────────────────

export type DisclosureDimension = 'harness' | 'suites' | 'model' | 'route' | 'effort' | 'repeats'

const DIMENSION_ORDER: readonly DisclosureDimension[] = [
	'harness',
	'suites',
	'model',
	'route',
	'effort',
	'repeats',
]

interface Fact {
	readonly dimension: DisclosureDimension
	readonly key: string
	/** Null is unknown. */
	readonly value: string | null
}

function known(value: unknown): string | null {
	return typeof value === 'string' && value !== UNKNOWN && value.length > 0 ? value : null
}

function canonical(value: unknown): string | null {
	if (value === undefined || value === null || value === UNKNOWN) return null
	if (typeof value === 'string') return value
	return JSON.stringify(value, (_key, v) =>
		isRecord(v)
			? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
			: v,
	)
}

function rolesFact(value: unknown): string | null {
	if (!isRecord(value)) return null
	const parts: string[] = []
	for (const role of Object.keys(value).sort()) {
		const who = value[role]
		const provider = isRecord(who) ? known(who.provider) : null
		const model = isRecord(who) ? known(who.model) : null
		if (provider === null || model === null) return null
		parts.push(`${role}=${provider}/${model}`)
	}
	return parts.length === 0 ? 'no model' : parts.join('; ')
}

function firstKnown(suites: readonly LoadedSuite[], field: string): string | null {
	for (const suite of suites) {
		const value = known(suite.facts?.[field])
		if (value !== null) return value
	}
	return null
}

function factsOf(file: LoadedReportFile, suiteIds: readonly string[]): Fact[] {
	const facts: Fact[] = [
		{
			dimension: 'harness',
			key: 'harness version',
			value: firstKnown(file.suites, 'harnessVersion'),
		},
		{ dimension: 'harness', key: 'sdk version', value: firstKnown(file.suites, 'sdkVersion') },
		{ dimension: 'harness', key: 'commit', value: firstKnown(file.suites, 'commit') },
	]
	for (const id of suiteIds) {
		const suite = file.suites.find((s) => s.id === id)
		if (!suite) continue
		const f = suite.facts
		facts.push(
			{ dimension: 'suites', key: `${id} version`, value: known(f?.suiteVersion) },
			{ dimension: 'model', key: `${id} mode`, value: known(f?.mode) },
			{ dimension: 'model', key: `${id} models`, value: rolesFact(f?.roles) },
			{ dimension: 'route', key: `${id} routing`, value: canonical(f?.routing) },
			{ dimension: 'effort', key: `${id} reasoning effort`, value: known(f?.reasoningEffort) },
			// A file from before repeats existed ran every case once.
			{ dimension: 'repeats', key: `${id} repeats`, value: String(suite.repeats) },
		)
	}
	return facts
}

export interface DisclosureDifference {
	readonly dimension: DisclosureDimension
	readonly key: string
	readonly a: string
	readonly b: string
}

export interface DisclosureUnknown {
	readonly dimension: DisclosureDimension
	readonly key: string
	/** Which side does not say; the other side's value is given. */
	readonly missingIn: 'a' | 'b'
	readonly value: string
}

export interface DisclosureComparison {
	readonly differences: readonly DisclosureDifference[]
	/** Facts one side states and the other does not. */
	readonly unknown: readonly DisclosureUnknown[]
	/** Dimensions in which at least one stated fact differs, in a fixed order. */
	readonly differingDimensions: readonly DisclosureDimension[]
	/** Set when more than one dimension differs. */
	readonly warning?: string
}

function compareDisclosure(
	a: LoadedReportFile,
	b: LoadedReportFile,
	sharedSuites: readonly string[],
): DisclosureComparison {
	const left = new Map(factsOf(a, sharedSuites).map((f) => [f.key, f]))
	const right = new Map(factsOf(b, sharedSuites).map((f) => [f.key, f]))
	const differences: DisclosureDifference[] = []
	const unknown: DisclosureUnknown[] = []
	for (const [key, fa] of left) {
		const fb = right.get(key) as Fact
		if (fa.value !== null && fb.value !== null) {
			if (fa.value !== fb.value) {
				differences.push({ dimension: fa.dimension, key, a: fa.value, b: fb.value })
			}
		} else if (fa.value !== null || fb.value !== null) {
			unknown.push({
				dimension: fa.dimension,
				key,
				missingIn: fa.value === null ? 'a' : 'b',
				value: (fa.value ?? fb.value) as string,
			})
		}
	}
	const differingDimensions = DIMENSION_ORDER.filter((d) =>
		differences.some((x) => x.dimension === d),
	)
	return {
		differences,
		unknown,
		differingDimensions,
		...(differingDimensions.length > 1
			? {
					warning: `More than one thing differs between these two runs (${differingDimensions.join(', ')}), so a difference in the scores cannot be attributed to any one of them.`,
				}
			: {}),
	}
}

// ─── the comparison ──────────────────────────────────────────────────────

export interface CaseRef {
	readonly suite: string
	readonly case: string
}

export interface SideNumbers {
	/** Over the paired cases only. */
	readonly mean: number | null
	readonly passRate: number | null
}

export interface Flips {
	/** Cases that passed in every run on side B and not on side A. */
	readonly onlyBPasses: number
	/** The reverse: passed in every run on side A and not on side B. */
	readonly onlyAPasses: number
	readonly bothPass: number
	readonly bothFail: number
	/** Exact two-sided sign test on the two flip counts; 1 with no flips. */
	readonly pValue: number
	readonly test: 'exact two-sided sign test on the cases that flipped'
}

export interface EvalComparison {
	readonly seed: number
	readonly a: { readonly label: string; readonly cases: number }
	readonly b: { readonly label: string; readonly cases: number }
	readonly onlyInA: readonly CaseRef[]
	readonly onlyInB: readonly CaseRef[]
	/** Present on both sides but with no judged run on one of them. */
	readonly notJudged: readonly CaseRef[]
	readonly paired: number
	readonly sideA: SideNumbers
	readonly sideB: SideNumbers
	/** B minus A. */
	readonly difference: DifferenceIntervals
	readonly flips: Flips
	readonly verdict: {
		readonly claim: 'better' | 'worse' | 'none'
		/** The one sentence. */
		readonly sentence: string
		/** Why, in plain words. */
		readonly detail: string
		/**
		 * Why no winner is named although the numbers might say one. Empty when
		 * the comparison is on the held-out split, between different settings, over
		 * the same tasks: the one case in which it speaks.
		 */
		readonly withheld: readonly WithheldReason[]
	}
	readonly disclosure: DisclosureComparison
	/** The settings each report ran under, and what differs between the two. */
	readonly settings: SettingsComparison
	/** The split each report ran. Null when a report does not say (an older one). */
	readonly split: { readonly a: SideSplit; readonly b: SideSplit }
}

/** `mixed` when the suites of one report ran different splits. */
export type SideSplit = SplitFilter | 'mixed' | null

export interface SnapshotRef {
	readonly name: string
	readonly digest: string
}

export interface SettingsComparison {
	/** Null when the report has no snapshot (it was written before reports carried one). */
	readonly a: SnapshotRef | null
	readonly b: SnapshotRef | null
	/** Null when either side has no snapshot. */
	readonly identical: boolean | null
	/** Key by key; empty when the snapshots are identical or either is missing. */
	readonly differences: readonly SettingDifference[]
	/** Suites that ran under settings but never read them, so the settings cannot have moved them. */
	readonly notRead: { readonly a: readonly string[]; readonly b: readonly string[] }
}

/** Why a comparison does not name a winner, besides the numbers not supporting one. */
export type WithheldReason =
	| 'tune-split'
	| 'identical-settings'
	| 'no-snapshot'
	| 'tasks-differ'
	| 'not-held-out'

function sorted(refs: CaseRef[]): CaseRef[] {
	return refs.sort((x, y) =>
		x.suite === y.suite ? (x.case < y.case ? -1 : 1) : x.suite < y.suite ? -1 : 1,
	)
}

function signed(value: number, digits = 3): string {
	const text = value.toFixed(digits)
	return value > 0 ? `+${text}` : text
}

export function compareEvalReports(
	a: LoadedReportFile,
	b: LoadedReportFile,
	options: { seed?: number } = {},
): EvalComparison {
	const seed = validateSeed(options.seed)
	const index = (file: LoadedReportFile) => {
		const map = new Map<string, { ref: CaseRef; runs: CaseRuns }>()
		for (const suite of file.suites) {
			for (const c of suite.cases) {
				map.set(`${suite.id}\u0000${c.name}`, { ref: { suite: suite.id, case: c.name }, runs: c })
			}
		}
		return map
	}
	const left = index(a)
	const right = index(b)

	const onlyInA: CaseRef[] = []
	const onlyInB: CaseRef[] = []
	const notJudged: CaseRef[] = []
	const pairs: PairedTally[] = []
	let onlyBPasses = 0
	let onlyAPasses = 0
	let bothPass = 0
	let bothFail = 0

	for (const [key, l] of left) {
		const r = right.get(key)
		if (!r) {
			onlyInA.push(l.ref)
			continue
		}
		const ta = tallyOf(l.runs.runs)
		const tb = tallyOf(r.runs.runs)
		if (!ta || !tb) {
			notJudged.push(l.ref)
			continue
		}
		pairs.push({ a: ta, b: tb })
		const passA = passedEveryRun(l.runs.runs)
		const passB = passedEveryRun(r.runs.runs)
		if (passA && passB) bothPass++
		else if (!passA && !passB) bothFail++
		else if (passB) onlyBPasses++
		else onlyAPasses++
	}
	for (const [key, r] of right) if (!left.has(key)) onlyInB.push(r.ref)

	const aSide: readonly CaseTally[] = pairs.map((p) => p.a)
	const bSide: readonly CaseTally[] = pairs.map((p) => p.b)
	const numbers = (tallies: readonly CaseTally[]): SideNumbers => {
		if (tallies.length === 0) return { mean: null, passRate: null }
		const [mean, passRate] = pooledMeanAndRate(tallies)
		return { mean, passRate }
	}

	const difference = bootstrapPairedDifference(pairs, seed)
	const flips: Flips = {
		onlyBPasses,
		onlyAPasses,
		bothPass,
		bothFail,
		pValue: exactSignTestP(onlyBPasses, onlyAPasses),
		test: 'exact two-sided sign test on the cases that flipped',
	}
	const settings = compareSettings(a, b, sharedSuiteIds(a, b))
	const split = { a: splitOf(a), b: splitOf(b) }
	const withheld = withheldReasons(settings, split, onlyInA.length + onlyInB.length)
	const verdict =
		withheld.length > 0
			? withhold(withheld, settings, onlyInA.length, onlyInB.length, difference.mean, pairs.length)
			: { ...decide(difference.mean, pairs.length, flips), withheld: [] as WithheldReason[] }
	const sharedSuites = a.suites.map((s) => s.id).filter((id) => b.suites.some((s) => s.id === id))

	return {
		seed,
		a: { label: a.label, cases: left.size },
		b: { label: b.label, cases: right.size },
		onlyInA: sorted(onlyInA),
		onlyInB: sorted(onlyInB),
		notJudged: sorted(notJudged),
		paired: pairs.length,
		sideA: numbers(aSide),
		sideB: numbers(bSide),
		difference,
		flips,
		verdict,
		disclosure: compareDisclosure(a, b, sharedSuites),
		settings,
		split,
	}
}

function sharedSuiteIds(a: LoadedReportFile, b: LoadedReportFile): string[] {
	return a.suites.map((s) => s.id).filter((id) => b.suites.some((s) => s.id === id))
}

function snapshotOf(file: LoadedReportFile): LoadedSettings | undefined {
	return file.suites.find((s) => s.settings !== undefined)?.settings
}

function splitOf(file: LoadedReportFile): SideSplit {
	const requested = new Set(file.suites.map((s) => s.split))
	if (requested.size === 0 || requested.has(undefined)) return null
	return requested.size === 1 ? ([...requested][0] as SplitFilter) : 'mixed'
}

function compareSettings(
	a: LoadedReportFile,
	b: LoadedReportFile,
	shared: readonly string[],
): SettingsComparison {
	const left = snapshotOf(a)
	const right = snapshotOf(b)
	const ref = (x: LoadedSettings | undefined): SnapshotRef | null =>
		x === undefined ? null : { name: x.name, digest: x.digest }
	const ignored = (file: LoadedReportFile) =>
		file.suites
			.filter(
				(s) =>
					shared.includes(s.id) &&
					s.settings?.read === false &&
					Object.keys(s.settings.values).length > 0,
			)
			.map((s) => s.id)
	const identical = left && right ? left.digest === right.digest : null
	return {
		a: ref(left),
		b: ref(right),
		identical,
		differences: left && right && !identical ? diffSettings(left.values, right.values) : [],
		notRead: { a: ignored(a), b: ignored(b) },
	}
}

function withheldReasons(
	settings: SettingsComparison,
	split: { a: SideSplit; b: SideSplit },
	taskMismatches: number,
): WithheldReason[] {
	const out: WithheldReason[] = []
	if (settings.a === null || settings.b === null) out.push('no-snapshot')
	if (taskMismatches > 0) out.push('tasks-differ')
	// The most informative reason first: identical settings say the whole
	// difference is noise, whatever split they ran on.
	if (settings.identical === true) out.push('identical-settings')
	const tune = split.a === 'tune' || split.b === 'tune'
	if (tune) out.push('tune-split')
	else if (
		settings.a !== null &&
		settings.b !== null &&
		(split.a !== 'held-out' || split.b !== 'held-out')
	) {
		out.push('not-held-out')
	}
	return out
}

function short(digest: string): string {
	return digest.slice(0, 12)
}

function withhold(
	reasons: readonly WithheldReason[],
	settings: SettingsComparison,
	onlyA: number,
	onlyB: number,
	mean: Interval,
	paired: number,
): EvalComparison['verdict'] {
	const text: Record<WithheldReason, string> = {
		'tune-split':
			'these are the tasks the settings were chosen on; run the held-out split to judge',
		'identical-settings': `the two reports ran under identical settings (${settings.a?.name ?? 'unnamed'}, ${short(settings.a?.digest ?? '')}), so any difference between them is run-to-run noise`,
		'no-snapshot':
			'a report has no settings snapshot (it was written before reports named their settings), so what the two runs changed is not known',
		'tasks-differ': `the two reports ran different tasks (${onlyA} only in A, ${onlyB} only in B), so their numbers are not about the same tasks`,
		'not-held-out':
			'a report ran on all tasks or a mix of splits, which include the tasks the settings were chosen on; run the held-out split to judge',
	}
	const numbers = mean.computed
		? `the paired difference in mean score over ${paired} paired cases is ${signed(mean.estimate)}, 95% interval [${mean.low.toFixed(3)}, ${mean.high.toFixed(3)}]`
		: `no interval: ${mean.reason}`
	return {
		claim: 'none',
		sentence: `no winner is named: ${text[reasons[0] as WithheldReason]}`,
		detail: `${[...reasons.slice(1).map((r) => text[r]), numbers].join('; ')}.`,
		withheld: reasons,
	}
}

/** The sign test must be at least this convincing before the sentence names a winner. */
const CLAIM_P = 0.05

/** Bounds are judged at the precision they are printed at. */
function atPrintedPrecision(value: number): number {
	return Math.round(value * 1000) / 1000 || 0
}

function decide(
	mean: Interval,
	paired: number,
	flips: Flips,
): Omit<EvalComparison['verdict'], 'withheld'> {
	const none = 'no difference can be claimed at this size'
	if (!mean.computed) {
		return { claim: 'none', sentence: none, detail: `no interval: ${mean.reason}.` }
	}
	const range = `[${mean.low.toFixed(3)}, ${mean.high.toFixed(3)}]`
	// A bound is zero when it prints as zero: sums that differ by rounding only
	// (the same scores added in another order) must not read as a difference.
	const low = atPrintedPrecision(mean.low)
	const high = atPrintedPrecision(mean.high)
	const excludesZero = (low > 0 || high < 0) && atPrintedPrecision(mean.estimate) !== 0
	if (!excludesZero) {
		return {
			claim: 'none',
			sentence: none,
			detail: `the 95% interval ${range} for the difference in mean score over ${paired} paired cases includes zero.`,
		}
	}
	const flipped = flips.onlyAPasses + flips.onlyBPasses
	if (flipped > 0 && flips.pValue >= CLAIM_P) {
		return {
			claim: 'none',
			sentence: none,
			detail: `the 95% interval ${range} over ${paired} paired cases excludes zero, but the exact test on the ${flipped} case${flipped === 1 ? '' : 's'} that flipped gives p = ${flips.pValue.toFixed(4)}, not below ${CLAIM_P}; two checks that disagree are not a finding.`,
		}
	}
	const better = low > 0
	const size = Math.abs(mean.estimate).toFixed(3)
	return {
		claim: better ? 'better' : 'worse',
		sentence: `B is ${better ? 'better' : 'worse'} than A by ${size} in mean score, 95% interval ${range}`,
		detail: `the interval over ${paired} paired cases excludes zero${flipped > 0 ? ` and the exact test on the flips agrees (p = ${flips.pValue.toFixed(4)})` : ''}.`,
	}
}

function listCases(title: string, refs: readonly CaseRef[]): string[] {
	if (refs.length === 0) return [`${title}: none`]
	const shown = refs.slice(0, 20).map((r) => `  ${r.suite} / ${r.case}`)
	if (refs.length > shown.length) shown.push(`  and ${refs.length - shown.length} more`)
	return [`${title} (${refs.length}):`, ...shown]
}

function intervalText(interval: Interval, show: (n: number) => string): string {
	if (!interval.computed) return `no interval: ${interval.reason}`
	return `95% paired interval [${show(interval.low)}, ${show(interval.high)}]`
}

export function formatEvalComparison(c: EvalComparison): string {
	const score = (n: number | null) => (n === null ? 'none' : n.toFixed(3))
	const rate = (n: number | null) => (n === null ? 'none' : `${(n * 100).toFixed(1)}%`)
	const points = (n: number) => `${signed(n * 100, 1)} points`
	const lines = [
		`A: ${c.a.label} (${c.a.cases} cases)`,
		`B: ${c.b.label} (${c.b.cases} cases)`,
		`Cases are paired by suite and id; ${c.paired} paired${c.notJudged.length > 0 ? `, ${c.notJudged.length} more present on both but not judged on one side` : ''}. Seed ${c.seed}.`,
		'',
		...listCases('Only in A', c.onlyInA),
		...listCases('Only in B', c.onlyInB),
		'',
		`Mean score: A ${score(c.sideA.mean)}, B ${score(c.sideB.mean)}${c.difference.mean.estimate !== null ? `, difference ${signed(c.difference.mean.estimate)}` : ''}; ${intervalText(c.difference.mean, (n) => signed(n))}`,
		`Pass rate: A ${rate(c.sideA.passRate)}, B ${rate(c.sideB.passRate)}${c.difference.passRate.estimate !== null ? `, difference ${points(c.difference.passRate.estimate)}` : ''}; ${intervalText(c.difference.passRate, (n) => points(n))}`,
		`Flips: ${c.flips.onlyBPasses} case${c.flips.onlyBPasses === 1 ? '' : 's'} passed on B and not on A, ${c.flips.onlyAPasses} passed on A and not on B (${c.flips.bothPass} passed on both, ${c.flips.bothFail} failed on both). A case passes when every one of its runs passed. ${c.flips.test}: p = ${c.flips.pValue.toFixed(4)}`,
		'',
		`${c.verdict.sentence}.`,
		`  (${c.verdict.detail})`,
		'',
	]
	const ref = (x: SnapshotRef | null) =>
		x === null ? 'none recorded' : `"${x.name}" (sha256 ${short(x.digest)})`
	lines.push(
		`Settings: A ${ref(c.settings.a)}, B ${ref(c.settings.b)}. Split: A ${c.split.a ?? 'not recorded'}, B ${c.split.b ?? 'not recorded'}.`,
	)
	if (c.settings.identical === true) {
		lines.push('The two runs ran under identical settings.')
	} else if (c.settings.differences.length > 0) {
		lines.push('What differs in the settings:')
		const show = (v: unknown, has: boolean) => (has ? JSON.stringify(v) : 'not stated')
		for (const x of c.settings.differences) {
			lines.push(`  ${x.key}: A ${show(x.a, 'a' in x)}, B ${show(x.b, 'b' in x)}`)
		}
	}
	for (const side of ['a', 'b'] as const) {
		if (c.settings.notRead[side].length > 0) {
			lines.push(
				`Suites that ran under settings but did not read them (${side.toUpperCase()}): ${c.settings.notRead[side].join(', ')}`,
			)
		}
	}
	lines.push('')
	const d = c.disclosure
	if (d.differences.length === 0) {
		lines.push('What the two reports say about how they were produced: no stated difference.')
	} else {
		lines.push('What differs in how the two reports were produced:')
		for (const x of d.differences) lines.push(`  ${x.key}: A ${x.a}, B ${x.b}`)
	}
	if (d.unknown.length > 0) {
		lines.push('Stated on one side only, so it cannot be compared:')
		for (const x of d.unknown) {
			lines.push(
				`  ${x.key}: ${x.missingIn === 'a' ? 'A does not say' : 'B does not say'}, the other says ${x.value}`,
			)
		}
	}
	if (d.warning) lines.push('', `Warning: ${d.warning}`)
	return lines.join('\n')
}
