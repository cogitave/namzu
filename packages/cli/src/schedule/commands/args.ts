/**
 * `namzu schedule <verb>` arguments: `--flag value`, `--flag=value`,
 * repeatable flags and positionals, parsed without a library so every verb
 * reports an unknown flag by name.
 */

import { resolve } from 'node:path'
import { resolveNamzuHome } from '../../integrations/state/home.js'
import { type SchedulePaths, schedulePaths } from '../paths.js'

export interface ParsedArgs {
	readonly positionals: string[]
	readonly flags: Map<string, string[]>
	readonly unknown: string[]
}

/** Parse `argv` against the flags this verb takes: `name` (value) or `name!` (boolean). */
export function parseArgs(argv: readonly string[], spec: readonly string[]): ParsedArgs {
	const takesValue = new Set(spec.filter((s) => !s.endsWith('!')))
	const booleans = new Set(spec.filter((s) => s.endsWith('!')).map((s) => s.slice(0, -1)))
	const flags = new Map<string, string[]>()
	const positionals: string[] = []
	const unknown: string[] = []
	let onlyPositionals = false
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string
		if (onlyPositionals || !arg.startsWith('--') || arg === '--') {
			if (arg === '--' && !onlyPositionals) {
				onlyPositionals = true
				continue
			}
			positionals.push(arg)
			continue
		}
		const eq = arg.indexOf('=')
		const name = arg.slice(2, eq > 0 ? eq : undefined)
		if (booleans.has(name)) {
			flags.set(name, ['true'])
			continue
		}
		if (!takesValue.has(name)) {
			unknown.push(arg)
			continue
		}
		const value = eq > 0 ? arg.slice(eq + 1) : argv[++i]
		if (value === undefined) {
			unknown.push(`${arg} (needs a value)`)
			continue
		}
		flags.set(name, [...(flags.get(name) ?? []), value])
	}
	return { positionals, flags, unknown }
}

export function flag(args: ParsedArgs, name: string): string | undefined {
	return args.flags.get(name)?.at(-1)
}

export function has(args: ParsedArgs, name: string): boolean {
	return args.flags.has(name)
}

/** `--home` wins over `NAMZU_HOME` and the default. */
export function pathsFor(args: ParsedArgs): SchedulePaths {
	const home = flag(args, 'home')
	return schedulePaths(home ? resolve(home) : resolveNamzuHome())
}

/** `90s`, `30m`, `2h`, `1d` or plain milliseconds. */
export function parseMs(label: string, text: string | undefined): number | undefined {
	if (text === undefined) return undefined
	const match = /^(\d+)(ms|s|m|h|d)?$/.exec(text.trim())
	if (!match) throw new Error(`${label}: "${text}" is not a duration (write 90s, 30m, 2h, 1d)`)
	const n = Number(match[1])
	const unit = match[2] ?? 'ms'
	const scale: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }
	return n * (scale[unit] ?? 1)
}

export function parseCount(label: string, text: string | undefined): number | undefined {
	if (text === undefined) return undefined
	const n = Number(text.replaceAll('_', ''))
	if (!Number.isSafeInteger(n) || n < 0)
		throw new Error(`${label}: "${text}" is not a whole number`)
	return n
}

export function interactive(): boolean {
	return Boolean(process.stdin.isTTY && process.stderr.isTTY)
}
