/**
 * `namzu eval` — discover eval suites, run them, and set an exit code.
 *
 * The harness has been a library function and a string formatter: no
 * command, no CI step, and `formatReport` ending at `lines.join('\n')`
 * with no file write and no exit code. Its stated purpose is to give a
 * behaviour change a regression signal, and that signal could not reach CI
 * without every consumer hand-writing the runner and the
 * report-to-exit-code mapping.
 *
 * The data was never the missing part — `ExperimentReport` is fully
 * structured and JSON-serializable. What was missing is discovery,
 * serialization, and a documented exit contract.
 */

import { execFile } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { Command, CommanderError } from 'commander'

import type { ExperimentReport, SettingsSnapshot, SplitFilter } from '@namzu/sdk'
import {
	DEFAULT_EVAL_SEED,
	compareEvalReports,
	defaultSettingsSnapshot,
	formatEvalComparison,
	formatReport,
	formatRunSummary,
	isEvalUsageError,
	loadEvalReportFile,
	summarizeRun,
	validateSplitFilter,
	withEvalRunOptions,
} from '@namzu/sdk'

import { CLI_VERSION } from '../version.js'
import { EvalSettingsError, readEvalSettings } from './eval-settings.js'
import type { CommandContext, CommandDef } from './types.js'

const run = promisify(execFile)

/**
 * Exit codes, documented because CI branches on them.
 *
 * `2` is separate from `1` on purpose: a suite where no scorer could
 * judge anything is a BROKEN HARNESS, not a regression, and the two need
 * opposite responses. Collapsing them sends somebody hunting a behaviour
 * change that never happened.
 */
export const EVAL_EXIT = {
	/** Every case passed. */
	ok: 0,
	/** At least one case failed. A real regression signal. */
	failed: 1,
	/** At least one case was inconclusive — the harness could not judge. */
	inconclusive: 2,
	/** No suite was found, or one could not be loaded. */
	usage: 3,
} as const

const SUITE_SUFFIX = '.eval.js'

/**
 * How long one suite may take before the runner stops waiting.
 *
 * Generous, because a suite driving real runs is legitimately slow, and the
 * point is not to police duration — it is that "never" has to be
 * distinguishable from "slow". Without a deadline the two are the same
 * observation, and the one that never finishes is the one that reports
 * success.
 */
const DEFAULT_SUITE_TIMEOUT_MS = 300_000

const TIMED_OUT = Symbol('eval.suite.timed-out')

/**
 * Race a suite against a deadline.
 *
 * The timer is cleared on the settled path so a fast suite does not hold the
 * event loop open for the rest of the deadline — which would turn this
 * guard into a five-minute pause at the end of every green run.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			work,
			new Promise<typeof TIMED_OUT>((resolve) => {
				timer = setTimeout(() => resolve(TIMED_OUT), ms)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

/** A discovered suite: its stable id and how to run it. */
interface DiscoveredSuite {
	/**
	 * Path-derived and stable across machines, so two commits' artifacts
	 * can be diffed. A name taken from inside the module would let two
	 * files claim the same id.
	 */
	readonly id: string
	readonly file: string
}

/**
 * Find `*.eval.js` under a root, deepest paths last.
 *
 * Duplicate ids are refused rather than resolved: with two suites under
 * one id, a report silently describes whichever ran last and a diff
 * against yesterday compares different things.
 */
export async function discoverSuites(root: string): Promise<DiscoveredSuite[]> {
	const found: DiscoveredSuite[] = []

	async function walk(dir: string): Promise<void> {
		let entries: Dirent[]
		try {
			entries = await readdir(dir, { withFileTypes: true, encoding: 'utf-8' })
		} catch {
			// An unreadable directory is not a discovery failure — a broken
			// suite is reported when it is loaded, and refusing to walk the
			// rest of the tree over one permission error would hide it.
			return
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const full = join(dir, entry.name)
			if (entry.isDirectory()) {
				if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
				await walk(full)
				continue
			}
			if (!entry.name.endsWith(SUITE_SUFFIX)) continue
			found.push({ id: suiteId(root, full), file: full })
		}
	}

	await walk(root)

	const seen = new Map<string, string>()
	for (const suite of found) {
		const previous = seen.get(suite.id)
		if (previous !== undefined) {
			throw new Error(
				`Two eval suites resolve to the id "${suite.id}": ${previous} and ${suite.file}. Ids are path-derived so artifacts from two commits can be diffed; with a duplicate, a report describes whichever ran last.`,
			)
		}
		seen.set(suite.id, suite.file)
	}

	return found
}

/** `suites/tools/read.eval.js` → `suites/tools/read`. Posix-separated. */
function suiteId(root: string, file: string): string {
	return relative(root, file).slice(0, -SUITE_SUFFIX.length).split(sep).join('/')
}

/**
 * A suite module's contract: a default export that runs and returns a
 * report.
 *
 * The `run` callback stays caller-owned by design — the harness is
 * deliberately independent of how a turn is constructed — so a suite
 * module owns everything about its own execution and hands back only the
 * structured result.
 */
type SuiteModule = {
	default?: () => Promise<ExperimentReport> | ExperimentReport
	tags?: readonly string[]
}

async function loadSuite(file: string): Promise<SuiteModule> {
	const mod = (await import(pathToFileURL(file).href)) as SuiteModule
	if (typeof mod.default !== 'function') {
		throw new Error(
			`Eval suite "${file}" must default-export a function returning an ExperimentReport (call \`runExperiment\` inside it).`,
		)
	}
	return mod
}

interface EvalOptions {
	readonly dir: string
	readonly tag?: string
	readonly out?: string
	readonly timeoutMs?: number
	readonly repeat?: number
	readonly seed?: number
	readonly settings?: string
	readonly settingsName?: string
	readonly split?: string
}

/** A whole number written in digits and nothing else, or undefined. */
function wholeNumber(text: string): number | undefined {
	return /^\d+$/.test(text.trim()) ? Number.parseInt(text, 10) : undefined
}

/**
 * The version of the nearest package that holds the suite, or `unknown`. A
 * suite that ships in a package says which release of its tests ran.
 */
async function suiteVersionOf(file: string): Promise<string | undefined> {
	let dir = dirname(file)
	for (;;) {
		try {
			const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf-8')) as {
				version?: unknown
			}
			if (typeof manifest.version === 'string') return manifest.version
		} catch {
			// No readable manifest here; look one level up.
		}
		const parent = dirname(dir)
		if (parent === dir) return undefined
		dir = parent
	}
}

/**
 * The source revision the suites were read from, when they sit in a git
 * checkout. Not read for suites installed under `node_modules`: the checkout
 * around an installed package is the consumer's project, not the suites'.
 */
async function commitOf(root: string): Promise<string | undefined> {
	if (root.split(sep).includes('node_modules')) return undefined
	try {
		const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeout: 5_000 })
		const commit = stdout.trim()
		if (!/^[0-9a-f]{7,64}$/.test(commit)) return undefined
		// A report must not name a commit that did not produce it: with
		// tracked files changed, the suites that ran are not that commit's.
		const changed = await run('git', ['status', '--porcelain', '--untracked-files=no'], {
			cwd: root,
			timeout: 5_000,
		})
		return changed.stdout.trim().length > 0 ? `${commit}-dirty` : commit
	} catch {
		return undefined
	}
}

/** The seed every suite used, when they all used the same one (a suite may set its own). */
function sharedSeed(reports: ReadonlyArray<{ report: ExperimentReport }>): number | undefined {
	const seeds = new Set(reports.map((r) => r.report.seed))
	const [only] = [...seeds]
	return seeds.size === 1 && typeof only === 'number' ? only : undefined
}

async function runEval(ctx: CommandContext, options: EvalOptions): Promise<number> {
	// What the run is given: the settings in the file, or none. The person's own
	// config files are not read, so a report does not depend on whose machine
	// made it.
	let settings: SettingsSnapshot
	let split: SplitFilter
	try {
		split = validateSplitFilter(options.split)
		if (options.settingsName !== undefined && options.settings === undefined) {
			throw new EvalSettingsError(
				'--settings-name names the snapshot of a settings file; give the file with --settings.',
			)
		}
		settings =
			options.settings === undefined
				? defaultSettingsSnapshot()
				: await readEvalSettings(options.settings, options.settingsName, (line) =>
						ctx.formatter.info(line),
					)
	} catch (err) {
		if (err instanceof EvalSettingsError || isEvalUsageError(err)) {
			ctx.formatter.error({ message: err.message })
			return EVAL_EXIT.usage
		}
		throw err
	}

	const root = isAbsolute(options.dir) ? options.dir : resolve(process.cwd(), options.dir)

	let suites: DiscoveredSuite[]
	try {
		suites = await discoverSuites(root)
	} catch (err) {
		ctx.formatter.error({ message: err instanceof Error ? err.message : String(err) })
		return EVAL_EXIT.usage
	}

	if (suites.length === 0) {
		ctx.formatter.error({
			message: `No eval suites found under ${root}. A suite is a file named *${SUITE_SUFFIX} that default-exports a function returning an ExperimentReport.`,
		})
		return EVAL_EXIT.usage
	}

	const reports: Array<{ suite: string; report: ExperimentReport }> = []
	let skipped = 0
	let emptied = 0
	const commit = await commitOf(root)

	for (const suite of suites) {
		let mod: SuiteModule
		try {
			mod = await loadSuite(suite.file)
		} catch (err) {
			ctx.formatter.error({ message: err instanceof Error ? err.message : String(err) })
			return EVAL_EXIT.usage
		}

		if (options.tag && !(mod.tags ?? []).includes(options.tag)) {
			skipped++
			continue
		}

		// The suite calls `runExperiment` itself, so what the operator asked for
		// reaches it through a scope rather than an argument: a suite written
		// before `--repeat` existed repeats like any other.
		const suiteVersion = await suiteVersionOf(suite.file)
		const settingsUse = { read: false }
		const scope = {
			settings,
			settingsUse,
			split,
			...(options.repeat !== undefined ? { repeats: options.repeat } : {}),
			...(options.seed !== undefined ? { seed: options.seed } : {}),
			harnessVersion: CLI_VERSION,
			...(commit !== undefined ? { commit } : {}),
			...(suiteVersion !== undefined ? { suiteVersion } : {}),
		}
		let report: ExperimentReport | typeof TIMED_OUT
		try {
			report = await withDeadline(
				withEvalRunOptions(scope, () =>
					Promise.resolve((mod.default as () => Promise<ExperimentReport>)()),
				),
				options.timeoutMs ?? DEFAULT_SUITE_TIMEOUT_MS,
			)
		} catch (err) {
			// A bad `--repeat` or seed reaches here from inside the suite. Only
			// those are usage errors: a RangeError the suite's own code threw is
			// a crash like any other.
			if (isEvalUsageError(err)) {
				ctx.formatter.error({ message: err.message })
				return EVAL_EXIT.usage
			}
			throw err
		}

		// A suite that never settles was the worst failure this command
		// had, because it did not look like a failure at all: the promise
		// stayed pending, node's event loop drained, `process.exit` was
		// never reached, and the process ended on the default code — zero.
		// A gate that reports success by hanging is worse than no gate,
		// since the green tick is what stops anyone looking.
		//
		// Inconclusive rather than failed, matching the rule the exit codes
		// already state: nothing was judged, so there is no regression to
		// report — there is a harness to fix.
		if (report === TIMED_OUT) {
			ctx.formatter.error({
				message: `Eval suite "${suite.id}" did not finish within ${options.timeoutMs ?? DEFAULT_SUITE_TIMEOUT_MS}ms. A suite that hangs judges nothing; raise --timeout-ms if it is genuinely slow, and look for a turn parked on an approval nobody is there to give if it is not.`,
			})
			return EVAL_EXIT.inconclusive
		}

		// A suite with no task in the split has nothing to say. It is named, not
		// dropped quietly: a split that left a suite out looks like a smaller run.
		if (report.cases.length === 0 && split !== 'all') {
			ctx.formatter.info(`Suite ${suite.id} has no task in the ${split} split; it did not run.`)
			emptied++
			continue
		}
		if (options.settings !== undefined && !settingsUse.read) {
			ctx.formatter.info(
				`Suite ${suite.id} does not read the settings, so they cannot have changed its result.`,
			)
		}
		reports.push({ suite: suite.id, report })
		ctx.formatter.print({ suite: suite.id, report, text: formatReport(report) })
	}

	// Named, not silently dropped: a filter that matched nothing looks
	// exactly like a green run otherwise, which is the worst possible way
	// for a CI gate to fail open.
	if (skipped > 0) {
		ctx.formatter.info(`${skipped} suite(s) skipped by --tag ${options.tag}`)
	}
	if (reports.length === 0 && emptied > 0) {
		ctx.formatter.error({ message: `No task falls in the ${split} split of the suites that ran.` })
		return EVAL_EXIT.usage
	}
	if (reports.length === 0) {
		ctx.formatter.error({ message: `No suite matched --tag ${options.tag}.` })
		return EVAL_EXIT.usage
	}

	const summary = summarizeRun(reports, {
		seed: options.seed ?? sharedSeed(reports) ?? DEFAULT_EVAL_SEED,
		harnessVersion: CLI_VERSION,
		sdkVersion:
			reports.find((r) => r.report.disclosure)?.report.disclosure?.sdkVersion ?? 'unknown',
		commit: commit ?? 'unknown',
		generatedAt: new Date().toISOString(),
		settings,
		split,
	})
	ctx.formatter.print({ run: summary, text: formatRunSummary(summary) })

	if (options.out) {
		await writeArtifact(options.out, reports, summary)
		ctx.formatter.info(`Wrote ${options.out}`)
	}

	const failed = reports.reduce((sum, r) => sum + r.report.failed, 0)
	const inconclusive = reports.reduce((sum, r) => sum + r.report.inconclusive, 0)

	// Inconclusive is checked FIRST. A suite that could not judge tells you
	// nothing about the cases it did judge, so reporting a regression on
	// the rest would be reporting a number that covers less evidence than
	// it appears to.
	if (inconclusive > 0) return EVAL_EXIT.inconclusive
	if (failed > 0) return EVAL_EXIT.failed
	return EVAL_EXIT.ok
}

async function writeArtifact(
	out: string,
	reports: Array<{ suite: string; report: ExperimentReport }>,
	summary: ReturnType<typeof summarizeRun>,
): Promise<void> {
	const path = isAbsolute(out) ? out : resolve(process.cwd(), out)
	await mkdir(join(path, '..'), { recursive: true })
	// The whole report, not a summary: two commits' artifacts are meant to
	// be diffable, and a summary cannot say which scorer moved.
	await writeFile(
		path,
		`${JSON.stringify({ schemaVersion: 2, run: summary, suites: reports }, null, 2)}\n`,
		'utf-8',
	)
}

export const evalCommand: CommandDef = {
	name: 'eval',
	description: 'Run eval suites and set an exit code',
	passThrough: true,
	handler: async ({ ctx, rawArgs }): Promise<number> => {
		const program = new Command('eval')
			.exitOverride()
			.description('Run eval suites and set an exit code')
			.option('-d, --dir <path>', 'Directory to discover *.eval.js suites in', 'packages/evals')
			.option('-t, --tag <tag>', 'Only run suites declaring this tag')
			.option('-o, --out <file>', 'Write the full JSON report to this path')
			.option(
				'--timeout-ms <ms>',
				'How long one suite may run before it is called inconclusive',
				(v) => Number.parseInt(v, 10),
			)
			.option('--repeat <n>', 'Run every case n times, from 1 to 100 (default 1)')
			.option(
				'--seed <n>',
				`Seed for the 95% intervals, an integer from 0 to 4294967295 (default ${DEFAULT_EVAL_SEED})`,
			)
			.option(
				'--settings <file>',
				'Run the suites under the settings in this JSON or YAML file (the shape of the config file, limited to what an eval may vary)',
			)
			.option(
				'--settings-name <name>',
				'Name the settings snapshot (default: the settings file name; "default" when there is no file)',
			)
			.option(
				'--split <split>',
				'Run one split of the tasks: tune, held-out or all (default all). Choose settings on tune, judge them on held-out',
			)
			.addHelpText(
				'after',
				'\nTo compare two reports written with --out: namzu eval compare <a.json> <b.json> [--json] [--seed <n>]',
			)

		if (rawArgs[0] === 'compare') return runCompare(ctx, rawArgs.slice(1))

		try {
			program.parse(rawArgs, { from: 'user' })
		} catch (err) {
			if (err instanceof CommanderError) {
				// `--help` and a parse error both land here; the former is
				// not a failure.
				return err.code === 'commander.helpDisplayed' ? EVAL_EXIT.ok : EVAL_EXIT.usage
			}
			throw err
		}

		// Kept as text by the parser and read here: a parser that returned
		// nothing for a bad value would leave the option looking unset.
		const raw = program.opts<{ repeat?: string; seed?: string }>()
		const repeat = raw.repeat === undefined ? undefined : wholeNumber(raw.repeat)
		const seed = raw.seed === undefined ? undefined : wholeNumber(raw.seed)
		if (raw.repeat !== undefined && (repeat === undefined || repeat < 1 || repeat > 100)) {
			ctx.formatter.error({ message: '--repeat takes a whole number from 1 to 100.' })
			return EVAL_EXIT.usage
		}
		if (raw.seed !== undefined && (seed === undefined || seed > 4294967295)) {
			ctx.formatter.error({ message: '--seed takes a whole number from 0 to 4294967295.' })
			return EVAL_EXIT.usage
		}
		const { repeat: _repeat, seed: _seed, ...rest } = program.opts<EvalOptions>()
		return runEval(ctx, {
			...rest,
			...(repeat !== undefined ? { repeat } : {}),
			...(seed !== undefined ? { seed } : {}),
		})
	},
}

async function readReportFile(path: string) {
	const full = isAbsolute(path) ? path : resolve(process.cwd(), path)
	let text: string
	try {
		text = await readFile(full, 'utf-8')
	} catch (err) {
		throw new Error(`Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`)
	}
	let json: unknown
	try {
		json = JSON.parse(text)
	} catch {
		throw new Error(`${path} is not JSON.`)
	}
	return loadEvalReportFile(json, path)
}

/**
 * `namzu eval compare <a.json> <b.json>`: two reports written by `--out`,
 * paired by suite and case id. Exits 0 whatever the answer is; the exit code
 * of a comparison does not say who won, and a script reads `--json`.
 */
async function runCompare(ctx: CommandContext, args: readonly string[]): Promise<number> {
	const program = new Command('eval compare')
		.exitOverride()
		.description('Compare two eval reports, paired by suite and case id')
		.argument('<a>', 'Report written by --out: the baseline')
		.argument('<b>', 'Report written by --out: the run being judged against it')
		.option('--json', 'Print the comparison as JSON')
		.option('--seed <n>', `Seed for the paired bootstrap (default ${DEFAULT_EVAL_SEED})`)
	try {
		program.parse([...args], { from: 'user' })
	} catch (err) {
		if (err instanceof CommanderError) {
			return err.code === 'commander.helpDisplayed' ? EVAL_EXIT.ok : EVAL_EXIT.usage
		}
		throw err
	}
	const opts = program.opts<{ json?: boolean; seed?: string }>()
	const [aPath, bPath] = program.args as [string, string]
	const seed = opts.seed === undefined ? undefined : wholeNumber(opts.seed)
	if (opts.seed !== undefined && (seed === undefined || seed > 4294967295)) {
		ctx.formatter.error({ message: '--seed takes a whole number from 0 to 4294967295.' })
		return EVAL_EXIT.usage
	}
	try {
		const comparison = compareEvalReports(
			await readReportFile(aPath),
			await readReportFile(bPath),
			seed === undefined ? {} : { seed },
		)
		if (opts.json) {
			// The text formatter prints a string as it is; the structured
			// formatters take the object and encode it themselves.
			ctx.formatter.print(
				ctx.formatter.name === 'text' ? JSON.stringify(comparison, null, 2) : comparison,
			)
		} else {
			ctx.formatter.print({ comparison, text: formatEvalComparison(comparison) })
		}
		return EVAL_EXIT.ok
	} catch (err) {
		ctx.formatter.error({ message: err instanceof Error ? err.message : String(err) })
		return EVAL_EXIT.usage
	}
}
