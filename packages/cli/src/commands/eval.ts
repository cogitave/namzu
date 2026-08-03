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

import type { Dirent } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { Command, CommanderError } from 'commander'

import type { ExperimentReport } from '@namzu/sdk'
import { formatReport } from '@namzu/sdk'

import type { CommandContext, CommandDef } from './types.js'

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
 * deliberately independent of how a run is constructed — so a suite
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
}

async function runEval(ctx: CommandContext, options: EvalOptions): Promise<number> {
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

		const report = await withDeadline(
			(mod.default as () => Promise<ExperimentReport>)(),
			options.timeoutMs ?? DEFAULT_SUITE_TIMEOUT_MS,
		)

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
				message: `Eval suite "${suite.id}" did not finish within ${options.timeoutMs ?? DEFAULT_SUITE_TIMEOUT_MS}ms. A suite that hangs judges nothing; raise --timeout-ms if it is genuinely slow, and look for a run parked on an approval nobody is there to give if it is not.`,
			})
			return EVAL_EXIT.inconclusive
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
	if (reports.length === 0) {
		ctx.formatter.error({ message: `No suite matched --tag ${options.tag}.` })
		return EVAL_EXIT.usage
	}

	if (options.out) {
		await writeArtifact(options.out, reports)
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
): Promise<void> {
	const path = isAbsolute(out) ? out : resolve(process.cwd(), out)
	await mkdir(join(path, '..'), { recursive: true })
	// The whole report, not a summary: two commits' artifacts are meant to
	// be diffable, and a summary cannot say which scorer moved.
	await writeFile(path, `${JSON.stringify({ suites: reports }, null, 2)}\n`, 'utf-8')
}

export const evalCommand: CommandDef = {
	name: 'eval',
	description: 'Run eval suites and set an exit code',
	passThrough: true,
	handler: async ({ ctx, rawArgs }): Promise<number> => {
		const program = new Command('eval')
			.exitOverride()
			.description('Run eval suites and set an exit code')
			.option('-d, --dir <path>', 'Directory to discover *.eval.js suites in', 'evals')
			.option('-t, --tag <tag>', 'Only run suites declaring this tag')
			.option('-o, --out <file>', 'Write the full JSON report to this path')
			.option(
				'--timeout-ms <ms>',
				'How long one suite may run before it is called inconclusive',
				(v) => Number.parseInt(v, 10),
			)

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

		return runEval(ctx, program.opts<EvalOptions>())
	},
}
