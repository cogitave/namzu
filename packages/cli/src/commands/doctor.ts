import type { DoctorCategory, DoctorCheckRecord, DoctorReport, DoctorStatus } from '@namzu/sdk'

import { builtInDoctorChecks } from '../doctor/checks/index.js'
import { type RunDoctorOptions, createDoctorRegistry, runDoctor } from '../doctor/registry.js'
import { EXIT_USAGE } from '../exit-codes.js'
import type { CommandDef } from './types.js'

const VALID_CATEGORIES: readonly DoctorCategory[] = [
	'sandbox',
	'providers',
	'vault',
	'telemetry',
	'runtime',
	'plugins',
	'custom',
]

interface ParsedArgs {
	readonly json: boolean
	readonly verbose: boolean
	readonly categories?: readonly DoctorCategory[]
	readonly perCheckTimeoutMs?: number
	readonly wallClockTimeoutMs?: number
	readonly help: boolean
	readonly error?: string
}

const HELP = `namzu doctor — health checks for the local Namzu environment

Usage:
  namzu doctor [options]

Options:
  --json                       Emit a machine-readable JSON report
  --verbose                    Include stack traces on failures
  --category <a,b,c>           Comma-separated category filter
                               (sandbox, providers, vault, telemetry,
                                runtime, plugins, custom)
  --per-check-timeout <ms>     Per-check timeout (default 5000)
  --wall-clock-timeout <ms>    Total wall-clock timeout (default 10000)
  -h, --help                   Show this help

Exit codes:
  0   every check answered, and none of them failed
  1   one or more checks reported \`fail\`
  2   no checks registered (Namzu not configured here)
  69  a check could not answer — it timed out, was aborted, or what it
      reads threw. Separate from 0 because a report that did not manage
      to look tells you nothing about the part it did look at, and
      separate from 1 because nothing was established to have failed.
  70  internal CLI error (sysexits EX_SOFTWARE)

A \`skipped\` check does not affect the exit code: it means there was
nothing here to check — an optional package absent, nothing configured
yet — which is an ordinary state of a healthy machine.
`

function parseArgs(args: readonly string[]): ParsedArgs {
	let json = false
	let verbose = false
	let help = false
	let categories: DoctorCategory[] | undefined
	let perCheckTimeoutMs: number | undefined
	let wallClockTimeoutMs: number | undefined

	for (let i = 0; i < args.length; i++) {
		const arg = args[i] as string
		switch (arg) {
			case '--json':
				json = true
				break
			case '--verbose':
				verbose = true
				break
			case '-h':
			case '--help':
				help = true
				break
			case '--category': {
				const value = args[++i]
				if (!value) return { json, verbose, help, error: '--category requires a value' }
				const parts = value
					.split(',')
					.map((p) => p.trim())
					.filter(Boolean)
				const invalid = parts.filter((p) => !VALID_CATEGORIES.includes(p as DoctorCategory))
				if (invalid.length > 0) {
					return {
						json,
						verbose,
						help,
						error: `unknown category: ${invalid.join(', ')} (valid: ${VALID_CATEGORIES.join(', ')})`,
					}
				}
				categories = parts as DoctorCategory[]
				break
			}
			case '--per-check-timeout': {
				const value = args[++i]
				if (!value)
					return {
						json,
						verbose,
						help,
						error: '--per-check-timeout requires a value',
					}
				const n = Number.parseInt(value, 10)
				if (!Number.isFinite(n) || n <= 0) {
					return {
						json,
						verbose,
						help,
						error: `--per-check-timeout must be a positive integer; got ${value}`,
					}
				}
				perCheckTimeoutMs = n
				break
			}
			case '--wall-clock-timeout': {
				const value = args[++i]
				if (!value)
					return {
						json,
						verbose,
						help,
						error: '--wall-clock-timeout requires a value',
					}
				const n = Number.parseInt(value, 10)
				if (!Number.isFinite(n) || n <= 0) {
					return {
						json,
						verbose,
						help,
						error: `--wall-clock-timeout must be a positive integer; got ${value}`,
					}
				}
				wallClockTimeoutMs = n
				break
			}
			default:
				return { json, verbose, help, error: `unknown option: ${arg}` }
		}
	}

	return {
		json,
		verbose,
		help,
		categories,
		perCheckTimeoutMs,
		wallClockTimeoutMs,
	}
}

function statusGlyph(status: DoctorStatus): string {
	switch (status) {
		case 'pass':
			return '✓'
		case 'fail':
			return '✗'
		case 'inconclusive':
			return '?'
		case 'warn':
			return '!'
		// The glyph `inconclusive` used to carry. It reads as "not applicable",
		// which is what this status means and what that status never did — so
		// the mark moves to the row it was describing all along, and the check
		// that could not answer takes the question mark.
		case 'skipped':
			return '⊘'
	}
}

function formatHumanReport(report: DoctorReport, verbose: boolean): string {
	const lines: string[] = []
	lines.push(`namzu doctor — ${report.timestamp}`)
	lines.push('')
	const widestCategory = report.checks.reduce(
		(w, c) => Math.max(w, c.category.length),
		'category'.length,
	)
	for (const record of report.checks) {
		const glyph = statusGlyph(record.status)
		const category = record.category.padEnd(widestCategory)
		const dur = `${record.durationMs}ms`
		const head = `  ${glyph} ${category}  ${record.id}  ${dur}`
		lines.push(head)
		// A message may be several lines — a provider chain is one line per
		// member. Pushed whole, only its first line took the indent and every
		// line after it broke out to column 0, so the report looked like it had
		// ended and the rest was something else's output.
		if (record.message) {
			for (const line of record.message.split('\n')) lines.push(`     ${line}`)
		}
		if (record.remediation) {
			const [first = '', ...rest] = record.remediation.split('\n')
			lines.push(`     → ${first}`)
			// Aligned under the text, not under the arrow.
			for (const line of rest) lines.push(`       ${line}`)
		}
	}
	lines.push('')
	const s = report.summary
	// Every status is counted, so the row sums to `total`. `skipped` was folded
	// into `inconc` while they were one word, which meant the line silently
	// reported an optional package's absence in the same figure as a check that
	// timed out — and a reader adding the numbers up got the right total for the
	// wrong reason.
	lines.push(
		`  pass: ${s.pass}  fail: ${s.fail}  warn: ${s.warn}  inconc: ${s.inconclusive}  skipped: ${s.skipped}  total: ${s.total}`,
	)
	lines.push(`  exit: ${report.exit}`)
	// Named where the number is, because `69` is the one code here a reader will
	// not recognise and the report is the only place they are looking.
	if (report.exit === 69) {
		lines.push('  (69: at least one check could not answer — see the ? rows above)')
	}
	if (verbose) {
		const failed = report.checks.filter((c: DoctorCheckRecord) => c.status === 'fail')
		if (failed.length > 0) {
			lines.push('')
			lines.push('Failures:')
			for (const f of failed) {
				lines.push(`  ${f.id}: ${f.message ?? '(no message)'}`)
			}
		}
	}
	return lines.join('\n')
}

export async function runDoctorCommand(args: readonly string[]): Promise<number> {
	const parsed = parseArgs(args)
	if (parsed.error) {
		process.stderr.write(`Error: ${parsed.error}\n\n${HELP}\n`)
		// The caller's arguments are wrong, not this command. Answering 70
		// here told an operator the CLI had broken and sent them to file a
		// bug for a typo.
		return EXIT_USAGE
	}
	if (parsed.help) {
		process.stdout.write(`${HELP}\n`)
		return 0
	}

	const registry = createDoctorRegistry()
	for (const check of builtInDoctorChecks) registry.register(check)

	const opts: RunDoctorOptions = {
		registry,
		categories: parsed.categories,
		perCheckTimeoutMs: parsed.perCheckTimeoutMs,
		wallClockTimeoutMs: parsed.wallClockTimeoutMs,
	}

	const report = await runDoctor(opts)

	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
	} else {
		process.stdout.write(`${formatHumanReport(report, parsed.verbose)}\n`)
	}

	return report.exit
}

/**
 * CommandDef adapter for the global registry. Preserves the legacy
 * `runDoctorCommand(args)` signature by forwarding raw arguments unparsed.
 */
export const doctorCommand: CommandDef = {
	name: 'doctor',
	description: 'Run health checks against the local Namzu environment',
	passThrough: true,
	handler: async ({ rawArgs }) => runDoctorCommand(rawArgs),
}
