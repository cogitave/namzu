import type { DoctorCategory, DoctorCheckRecord, DoctorReport, DoctorStatus } from '@namzu/sdk'

import { builtInDoctorChecks } from '../doctor/checks/index.js'
import { type RunDoctorOptions, createDoctorRegistry, runDoctor } from '../doctor/registry.js'
import { EXIT_INTERNAL_ERROR } from '../exit-codes.js'

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
  0   all checks passed (or no failure produced)
  1   one or more checks reported \`fail\`
  2   no checks registered (Namzu not configured here)
  70  internal CLI error (sysexits EX_SOFTWARE)
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
			return '⊘'
		case 'warn':
			return '!'
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
		if (record.message) lines.push(`     ${record.message}`)
		if (record.remediation) lines.push(`     → ${record.remediation}`)
	}
	lines.push('')
	const s = report.summary
	lines.push(
		`  pass: ${s.pass}  fail: ${s.fail}  warn: ${s.warn}  inconc: ${s.inconclusive}  total: ${s.total}`,
	)
	lines.push(`  exit: ${report.exit}`)
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
		return EXIT_INTERNAL_ERROR
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
