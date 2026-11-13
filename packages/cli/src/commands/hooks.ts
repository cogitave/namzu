import { type HookRow, type HooksReport, describeFolderHooks } from '../config/hooks-report.js'
import { EXIT_USAGE } from '../exit-codes.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { resolveWorkingDirectory } from './exec-flags.js'
import type { CommandDef } from './types.js'

const HELP = [
	'Usage: namzu hooks [--cwd <path>] [--json]',
	'',
	'Say what runs by itself in a folder: every hook from the config files, plugins,',
	'skills and agent files, where it comes from, whether it is on, and why not when',
	'it is not. Nothing of the folder is run or imported, so a folder nobody has',
	'trusted can be asked about: its own hooks are listed as not loaded, with what',
	'would start once it is trusted.',
	'',
	'Options:',
	'  --cwd <path>  Ask about this folder instead of the current one',
	'  --json        Print the answer as JSON (the same facts the Desktop app reads)',
].join('\n')

interface HooksFlags {
	readonly cwd: string | null
	readonly json: boolean
	readonly error?: string
}

export function parseHooksFlags(rawArgs: readonly string[]): HooksFlags {
	let cwd: string | null = null
	let json = false
	for (let index = 0; index < rawArgs.length; index++) {
		const arg = rawArgs[index] as string
		if (arg === '--json') {
			json = true
			continue
		}
		if (arg === '--cwd') {
			const value = rawArgs[index + 1]
			if (value === undefined || value.startsWith('--') || value.trim() === '') {
				return { cwd, json, error: '--cwd requires a directory path' }
			}
			cwd = value.trim()
			index++
			continue
		}
		if (arg.startsWith('--cwd=')) {
			const value = arg.slice('--cwd='.length).trim()
			if (!value) return { cwd, json, error: '--cwd requires a directory path' }
			cwd = value
			continue
		}
		return { cwd, json, error: `unknown hooks option or argument: ${arg}` }
	}
	return { cwd, json }
}

const oneLine = (text: string): string => terminalDisplayText(text).replace(/\s+/g, ' ').trim()

function stateWords(row: { state: string; why?: { text: string } }): string {
	switch (row.state) {
		case 'runs':
			return 'runs'
		case 'attaches-when-used':
			return 'attaches when used'
		case 'off':
			return `off: ${oneLine(row.why?.text ?? 'switched off')}`
		default:
			return `not loaded: ${oneLine(row.why?.text ?? 'cannot be loaded')}`
	}
}

function rowLine(row: HookRow): string {
	const event = row.eventWritten ? `${row.event} (${row.eventWritten})` : row.event
	const parts = [event]
	if (row.matcher) parts.push(`matches ${oneLine(row.matcher)}`)
	if (row.condition) parts.push(`if ${oneLine(row.condition)}`)
	parts.push(`${row.type}: ${oneLine(row.runs)}`)
	if (row.once) parts.push('once')
	if (row.async) parts.push('in background')
	if (row.timeoutMs !== undefined) parts.push(`${Math.round(row.timeoutMs / 1000)}s`)
	if (row.onFailure === 'block') parts.push('blocks when it fails')
	parts.push(stateWords(row))
	return `  ${parts.join(' · ')}`
}

/** The report as a person reads it. */
export function renderHooksReport(report: HooksReport): string {
	const lines: string[] = []
	lines.push(
		`Hooks for ${oneLine(report.folder.path)} (${report.folder.trusted ? 'trusted' : 'not trusted'})`,
	)
	const { switches } = report
	const where = (s: {
		on: boolean
		setBy?: { kind: string; path?: string; variable?: string }
	}) => {
		if (!s.setBy) return s.on ? 'on' : 'off'
		const at = s.setBy.variable ?? s.setBy.path ?? s.setBy.kind
		return `${s.on ? 'on' : 'off'} (${s.setBy.kind}${at !== s.setBy.kind ? `: ${at}` : ''})`
	}
	lines.push(
		`Switches: disableHooks ${where(switches.disableHooks)} · hooksManagedOnly ${where(switches.hooksManagedOnly)} · plugins ${where(switches.plugins)}`,
	)
	if (!report.folder.trusted) {
		lines.push(
			report.counts.waitingForTrust > 0
				? `This folder is not trusted: ${report.counts.waitingForTrust} hook${report.counts.waitingForTrust === 1 ? '' : 's'} in it would start once it is.`
				: 'This folder is not trusted; no hook in it was found that would start once it is.',
		)
	}
	const { counts } = report
	lines.push(
		`${counts.runs} run · ${counts.off} off · ${counts.attachesWhenUsed} attach when used · ${counts.notLoaded} not loaded`,
	)
	if (report.error) lines.push(`The configuration could not be read: ${oneLine(report.error)}`)
	const groups = new Map<string, HookRow[]>()
	for (const row of report.hooks) {
		const key = `${row.origin.label}\u0000${row.origin.kind}${row.origin.scope ? `, ${row.origin.scope}` : ''}`
		const list = groups.get(key) ?? []
		list.push(row)
		groups.set(key, list)
	}
	for (const [key, rows] of groups) {
		const [label, kind] = key.split('\u0000')
		lines.push('', `${oneLine(label ?? '')} (${kind})`)
		for (const row of rows) {
			lines.push(rowLine(row))
			for (const note of row.notes ?? []) lines.push(`    note: ${oneLine(note)}`)
		}
	}
	if (report.modules.length > 0) {
		lines.push('', 'JavaScript hook modules plugins list (named, not loaded here)')
		for (const module of report.modules) {
			lines.push(
				`  ${oneLine(module.origin.label)}: ${oneLine(module.module)} · ${stateWords(module)}`,
			)
		}
	}
	if (report.hooks.length === 0 && report.modules.length === 0) {
		lines.push('', 'No hook runs by itself here.')
	}
	if (report.problems.length > 0) {
		lines.push('', 'Problems and notes')
		for (const problem of report.problems) {
			const where = [problem.origin.label, problem.event, problem.file]
				.filter((part): part is string => part !== undefined && part !== '')
				.map(oneLine)
				.join(', ')
			const inactive = problem.inactive ? ' (not applied until the folder is trusted)' : ''
			lines.push(
				`  ${problem.severity === 'problem' ? 'Not loaded' : 'Note'}: ${where}: ${oneLine(problem.message)}${inactive}`,
			)
		}
	}
	return lines.join('\n')
}

export const hooksCommand: CommandDef = {
	name: 'hooks',
	description: 'Say what runs by itself in a folder: hooks, where from, and whether they are on',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const flags = parseHooksFlags(rawArgs)
		if (flags.error) {
			ctx.formatter.error({ message: flags.error })
			return EXIT_USAGE
		}
		const resolved = resolveWorkingDirectory(flags.cwd)
		if ('error' in resolved) {
			ctx.formatter.error({ message: resolved.error })
			return EXIT_USAGE
		}
		const report = await describeFolderHooks({ cwd: resolved.cwd })
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(report)}\n`)
			return 0
		}
		ctx.formatter.print({ ...report, text: renderHooksReport(report) })
		return 0
	},
}
