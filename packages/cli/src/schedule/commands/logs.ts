/**
 * `schedule logs [--follow] [--job <name>] [--since 1h]`: the daemon's log,
 * and `--run <run-id>` for one run's own output.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandContext } from '../../commands/types.js'
import { EXIT_OK, EXIT_USAGE } from '../../exit-codes.js'
import { findJob } from '../store/jobs.js'
import { flag, has, parseArgs, parseMs, pathsFor } from './args.js'

interface LogLine {
	readonly time?: string
	readonly timestamp?: string
	readonly level?: string
	readonly severityText?: string
	readonly body?: string
	readonly message?: string
	readonly attributes?: Record<string, unknown>
	readonly [key: string]: unknown
}

function render(line: LogLine): string {
	const at = String(line.time ?? line.timestamp ?? '')
	const level = String(line.level ?? line.severityText ?? '')
	const body = String(line.body ?? line.message ?? '')
	const attrs =
		line.attributes ??
		Object.fromEntries(Object.entries(line).filter(([k]) => k.startsWith('namzu.')))
	const shown = Object.entries(attrs)
		.filter(([k]) => k.startsWith('namzu.schedule.') || k === 'exception.message')
		.map(([k, v]) => `${k.replace('namzu.schedule.', '')}=${String(v)}`)
		.join(' ')
	return `${at} ${level} ${body}${shown ? `  ${shown}` : ''}`
}

function readLines(dir: string, sinceMs: number): { key: string; line: LogLine }[] {
	let names: string[]
	try {
		names = readdirSync(dir)
			.filter((n) => /^daemon-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n))
			.sort()
	} catch {
		return []
	}
	const out: { key: string; line: LogLine }[] = []
	for (const name of names) {
		const text = readFileSync(join(dir, name), 'utf8')
		text.split('\n').forEach((raw, i) => {
			if (!raw.trim()) return
			try {
				const line = JSON.parse(raw) as LogLine
				const at = Date.parse(String(line.time ?? line.timestamp ?? ''))
				if (Number.isFinite(at) && at < sinceMs) return
				out.push({ key: `${name}:${i}`, line })
			} catch {}
		})
	}
	return out
}

export async function logsCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'job', 'since', 'run', 'follow!'])
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const run = flag(args, 'run')
	if (run) {
		const job = flag(args, 'job')
		if (!job) {
			ctx.formatter.error({ message: '--run needs --job' })
			return EXIT_USAGE
		}
		const found = findJob(paths, job)
		try {
			ctx.formatter.print(readFileSync(paths.runLog(found.id, run), 'utf8'))
			return EXIT_OK
		} catch {
			ctx.formatter.error({ message: `no log for run ${run}` })
			return 1
		}
	}
	const since = Date.now() - (parseMs('--since', flag(args, 'since')) ?? 24 * 3_600_000)
	const jobId = flag(args, 'job') ? findJob(paths, flag(args, 'job') as string).id : undefined
	const matches = (line: LogLine) => {
		if (!jobId) return true
		const attrs = line.attributes ?? line
		return (attrs as Record<string, unknown>)['namzu.schedule.job_id'] === jobId
	}
	const seen = new Set<string>()
	const emit = () => {
		for (const { key, line } of readLines(paths.daemonLog, since)) {
			if (seen.has(key)) continue
			seen.add(key)
			if (matches(line)) ctx.formatter.print(render(line))
		}
	}
	emit()
	if (!has(args, 'follow')) return EXIT_OK
	await new Promise<void>((resolve) => {
		const timer = setInterval(emit, 1_000)
		const stop = () => {
			clearInterval(timer)
			resolve()
		}
		process.once('SIGINT', stop)
		process.once('SIGTERM', stop)
	})
	return EXIT_OK
}
