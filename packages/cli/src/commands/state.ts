import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { EXIT_FAIL, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import {
	type LegacyMoveResult,
	moveProjectLegacyState,
} from '../integrations/state/project-legacy.js'
import { cliProjectRoot } from '../integrations/state/project.js'
import {
	type PurgeOutcome,
	type PurgePlan,
	type PurgeSeams,
	executePurge,
	planAllPurge,
	planProjectPurge,
} from '../integrations/state/purge.js'
import { type NamzuStateReport, inspectNamzuState } from '../integrations/state/report.js'
import { homePath } from '../tui/person-terms.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import type { CommandDef } from './types.js'

const HELP = `namzu state — inspect local Namzu state, and move what an earlier Namzu left in a project

Usage:
  namzu state
  namzu state report
  namzu state move legacy [--dry-run]
  namzu state purge [path] [--dry-run] [--yes] [--all]

report (the default) lists what Namzu keeps and where, without changing
anything: it does not load project configuration, create a Session, repair,
move, chmod, or delete state.

move legacy moves the state an earlier Namzu kept in this folder's .namzu
(sessions/, projects/, checkpoints/, worktrees/, cli.json and the like) into
the Namzu home, under legacy/<folder>/<time>/. It runs only in a folder you
trust, moves only names an earlier Namzu wrote, and leaves in place what git
tracks, a git worktree with changes and anything it cannot check, saying why.
--dry-run says what would move and changes nothing.

purge deletes the state Namzu keeps in its home for one project (this folder's
by default, or the project of [path]): its conversations, checkpoints, file
history, plans, memory, recovery copies, its prompts in the prompt history and
its rows in the session index. It never deletes anything in the project folder
itself, so settings files kept there stay. It lists what it will delete and asks
first; with no terminal it needs --yes. It stops while a session of the project
is running, and while git worktrees Namzu made for it still exist.

Output:
  Use the global --format json or --format yaml flag for structured output.

Options:
  --dry-run   With move legacy or purge: list what would change, change nothing
  --yes       With purge: delete without asking
  --all       With purge: every project, not one
  -h, --help  Show this help`

export interface StateCommandDeps {
	readonly inspect: () => Promise<NamzuStateReport>
	readonly moveLegacy?: (options: { readonly dryRun: boolean }) => Promise<LegacyMoveResult>
	/** Test seams for `state purge`; each defaults to the real thing. */
	readonly purge?: {
		readonly cwd?: () => string
		readonly home?: () => string
		readonly isTerminal?: () => boolean
		readonly confirm?: (question: string) => Promise<boolean>
		readonly seams?: PurgeSeams
	}
}

export function createStateCommand(deps: StateCommandDeps): CommandDef {
	return {
		name: 'state',
		description: 'Inspect local Namzu state, or move what an earlier Namzu left in a project',
		passThrough: true,
		help: HELP,
		handler: async ({ ctx, rawArgs }) => {
			if (rawArgs[0] === 'move-legacy') {
				ctx.formatter.error({ message: 'This command is now `namzu state move legacy`.' })
				return EXIT_USAGE
			}
			if (rawArgs[0] === 'purge') return await runPurge(ctx.formatter, rawArgs.slice(1), deps.purge)
			if (rawArgs[0] === 'move' && rawArgs[1] === 'legacy') {
				const rest = rawArgs.slice(2)
				if (!(rest.length === 0 || (rest.length === 1 && rest[0] === '--dry-run'))) {
					ctx.formatter.error({ message: 'Usage: namzu state move legacy [--dry-run]' })
					return EXIT_USAGE
				}
				const move =
					deps.moveLegacy ??
					((options) =>
						moveProjectLegacyState({
							cwd: process.cwd(),
							home: resolveNamzuHome(),
							dryRun: options.dryRun,
						}))
				const result = await move({ dryRun: rest[0] === '--dry-run' })
				if (result.state === 'refused') {
					ctx.formatter.error({ message: result.reason })
					return EXIT_UNAVAILABLE
				}
				ctx.formatter.print({ ...result, text: renderLegacyMove(result) })
				return EXIT_OK
			}
			if (!(rawArgs.length === 0 || (rawArgs.length === 1 && rawArgs[0] === 'report'))) {
				ctx.formatter.error({
					message:
						'Usage: namzu state [report | move legacy [--dry-run] | purge [path] [--dry-run] [--yes] [--all]]',
				})
				return EXIT_USAGE
			}
			const report = await deps.inspect()
			ctx.formatter.print({ ...report, text: renderStateReport(report) })
			return EXIT_OK
		},
	}
}

type Fmt = Parameters<CommandDef['handler']>[0]['ctx']['formatter']

async function askOnTerminal(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stderr })
	try {
		const answer = await rl.question(question)
		return /^y(es)?$/i.test(answer.trim())
	} finally {
		rl.close()
	}
}

async function runPurge(
	formatter: Fmt,
	args: readonly string[],
	seams: StateCommandDeps['purge'] = {},
): Promise<number> {
	let dryRun = false
	let yes = false
	let all = false
	const operands: string[] = []
	for (const arg of args) {
		if (arg === '--dry-run') dryRun = true
		else if (arg === '--yes') yes = true
		else if (arg === '--all') all = true
		else if (arg.startsWith('-')) {
			formatter.error({ message: 'Usage: namzu state purge [path] [--dry-run] [--yes] [--all]' })
			return EXIT_USAGE
		} else operands.push(arg)
	}
	if (operands.length > 1 || (all && operands.length > 0)) {
		formatter.error({
			message: all
				? '`namzu state purge --all` takes no path.'
				: 'Usage: namzu state purge [path] [--dry-run] [--yes] [--all]',
		})
		return EXIT_USAGE
	}
	const isTerminal =
		seams.isTerminal ?? (() => Boolean(process.stdin.isTTY && process.stdout.isTTY))
	// Checked before anything is read or listed: with no terminal and no --yes there is nobody to ask.
	if (!dryRun && !yes && !isTerminal()) {
		formatter.error({
			message: 'There is no terminal to ask on: add --yes to delete, or --dry-run to only list.',
		})
		return EXIT_USAGE
	}
	const home = (seams.home ?? (() => resolveNamzuHome()))()
	let plan: PurgePlan
	if (all) {
		plan = await planAllPurge(home, seams.seams)
	} else {
		const cwd = (seams.cwd ?? (() => process.cwd()))()
		let folder: string
		try {
			folder = await realpath(resolve(cwd, operands[0] ?? '.'))
		} catch {
			formatter.error({ message: `There is no folder at ${safePath(operands[0] ?? cwd)}.` })
			return EXIT_USAGE
		}
		plan = await planProjectPurge(home, cliProjectRoot(folder), seams.seams)
	}
	const blocked = plan.projects.filter((project) => project.blocked !== undefined)
	const items = plan.projects.flatMap((project) => project.items)
	if (items.length === 0 && plan.history === undefined) {
		const text =
			blocked.length > 0
				? renderPurgePlan(plan, dryRun)
				: 'Nothing is kept in the Namzu home for this.'
		formatter.print({ ...plan, text })
		return blocked.length > 0 ? EXIT_FAIL : EXIT_OK
	}
	if (dryRun) {
		formatter.print({ ...plan, dryRun: true, text: renderPurgePlan(plan, true) })
		return blocked.length > 0 ? EXIT_FAIL : EXIT_OK
	}
	formatter.print({ ...plan, text: renderPurgePlan(plan, false) })
	if (!yes) {
		const ok = await (seams.confirm ?? askOnTerminal)('Delete this? [y/N] ')
		if (!ok) {
			formatter.print({ text: 'Nothing was deleted.' })
			return EXIT_OK
		}
	}
	const outcomes = await executePurge(plan, { all })
	formatter.print({ outcomes, text: renderPurgeOutcome(outcomes) })
	return outcomes.some((outcome) => outcome.failed.length > 0) || blocked.length > 0
		? EXIT_FAIL
		: EXIT_OK
}

export function renderPurgePlan(plan: PurgePlan, dryRun: boolean): string {
	const lines: string[] = [
		dryRun ? 'Would delete (nothing is deleted):' : 'This deletes, under the Namzu home:',
	]
	const describe = (item: PurgePlan['projects'][number]['items'][number]): string =>
		item.count !== undefined
			? `${item.count} ${item.count === 1 ? item.what.replace(/^(prompt|row)s /, '$1 ') : item.what}`
			: `${item.what}: ${formatBytes(item.bytes)} · ${item.files} files`
	for (const project of plan.projects) {
		lines.push('', project.folder !== null ? safePath(project.folder) : project.slug)
		if (project.blocked !== undefined) {
			lines.push(`  left alone: ${safeLine(project.blocked)}`)
			continue
		}
		for (const item of project.items) {
			lines.push(`  ${safePath(homePath(item.path))}`)
			lines.push(`    ${describe(item)}`)
		}
	}
	if (plan.history !== undefined) {
		lines.push('', `  ${safePath(homePath(plan.history.path))}`, `    ${describe(plan.history)}`)
	}
	lines.push('', 'Files inside the project folders are not touched.')
	return lines.join('\n')
}

export function renderPurgeOutcome(outcomes: readonly PurgeOutcome[]): string {
	const lines: string[] = []
	for (const outcome of outcomes) {
		for (const done of outcome.deleted) lines.push(`Deleted ${safePath(homePath(done))}`)
		for (const bad of outcome.failed) lines.push(`Could not delete ${safeLine(bad)}`)
	}
	return lines.length > 0 ? lines.join('\n') : 'Nothing was deleted.'
}

export const stateCommand: CommandDef = createStateCommand({
	inspect: inspectNamzuState,
})

/** What `namzu state move legacy` says it did, or with `--dry-run` would do. */
export function renderLegacyMove(
	result: Exclude<LegacyMoveResult, { state: 'refused' }>,
	show: (path: string) => string = (path) => safePath(homePath(path)),
): string {
	if (result.state === 'nothing') {
		return `Nothing to move: ${show(result.root)} holds no state an earlier Namzu kept there.`
	}
	const moved = result.outcomes.filter((outcome) => outcome.kind === 'moved')
	const kept = result.outcomes.filter((outcome) => outcome.kind === 'kept')
	const gone = result.outcomes.filter((outcome) => outcome.kind === 'gone')
	const lines: string[] = []
	if (moved.length > 0) {
		lines.push(
			result.dryRun
				? `Would move to ${show(result.destination)}/<time>:`
				: `Moved to ${show(result.destination)}:`,
		)
		for (const outcome of moved) lines.push(`  .namzu/${safeLine(outcome.name)}`)
	} else {
		lines.push(result.dryRun ? 'Nothing would move.' : 'Nothing was moved.')
	}
	if (kept.length > 0) {
		lines.push('Left in place:')
		for (const outcome of kept) {
			lines.push(
				`  .namzu/${safeLine(outcome.name)}: ${safeLine(outcome.reason)}${outcome.copy ? ` (copy: ${show(outcome.copy)})` : ''}`,
			)
		}
	}
	if (gone.length > 0) {
		lines.push(
			`Already moved by another Namzu: ${gone.map((outcome) => `.namzu/${safeLine(outcome.name)}`).join(', ')}`,
		)
	}
	if (!result.dryRun && moved.length > 0) {
		lines.push(
			'Namzu does not read these files. Keep them as long as you may want them, then delete the folder.',
		)
	}
	return lines.join('\n')
}

export function renderStateReport(report: NamzuStateReport): string {
	const lines = [
		'Namzu state — read-only inventory',
		`Scan complete: ${report.complete ? 'yes' : 'no'}`,
		`Snapshot: ${report.snapshot.consistency} — ${report.snapshot.detail}`,
		`Physical total: ${formatBytes(report.physicalTotals.logicalBytes)} · ${report.physicalTotals.files} files · ${report.physicalTotals.roots} roots`,
	]
	if (report.scopeRoots.overlap) {
		lines.push(
			'Project and user scopes resolve to the same physical .namzu directory; bytes are counted once.',
		)
	}

	for (const root of report.roots) {
		lines.push('')
		lines.push(`${root.roles.join(' + ')}: ${safePath(root.path)}`)
		if (!root.exists) {
			lines.push('  not initialized')
			continue
		}
		lines.push(
			`  ${formatBytes(root.logicalBytes)} · ${root.files} files · ${root.directories} directories`,
		)
		for (const [category, measure] of Object.entries(root.categories)) {
			if (measure.files === 0) continue
			lines.push(`  ${category}: ${formatBytes(measure.logicalBytes)} · ${measure.files} files`)
		}
		const inventory = root.inventory
		if (inventory.projects > 0 || inventory.sessionLogs.files > 0) {
			lines.push(
				`  projects ${inventory.projects} · session logs ${inventory.sessionLogs.files} (${formatBytes(inventory.sessionLogs.logicalBytes)}) · subagent logs ${inventory.subagentLogs.files} · checkpoints ${inventory.checkpointFiles.files} (${formatBytes(inventory.checkpointFiles.logicalBytes)})`,
			)
		}
		if (inventory.attachments.files > 0) {
			lines.push(
				`  attachment files ${inventory.attachments.files} (${formatBytes(inventory.attachments.logicalBytes)}) · ${inventory.attachments.pairs} complete pairs · ${inventory.attachments.orphanedDataFiles + inventory.attachments.orphanedTypeFiles} orphan halves`,
			)
		}
		const projectOnly = root.roles.length === 1 && root.roles[0] === 'project'
		if (root.legacy.length > 0) {
			lines.push(
				projectOnly
					? '  legacy (state an earlier Namzu kept in this folder; not read by this version, never changed here):'
					: '  legacy (the layout before session logs; not read by this version, never changed here):',
			)
			for (const entry of root.legacy) {
				lines.push(
					`    ${safePath(entry.path)} — ${formatBytes(entry.logicalBytes)} · ${entry.files} files`,
				)
			}
			if (projectOnly) {
				lines.push(
					'  namzu state move legacy moves it into the Namzu home (--dry-run lists what would move).',
				)
			}
		}
		for (const boundary of root.privacy) {
			if (boundary.status === 'secure') continue
			lines.push(
				`  privacy ${boundary.status}: ${safePath(boundary.path)} — ${safeLine(boundary.detail)}`,
			)
		}
		for (const issue of root.issues) {
			lines.push(`  issue ${issue.code}: ${safePath(issue.path)} — ${safeLine(issue.detail)}`)
		}
		if (root.omittedIssues > 0) lines.push(`  ${root.omittedIssues} additional issues omitted`)
	}

	lines.push('')
	lines.push(
		`Project binding: ${report.projectBinding.status} — ${safeLine(report.projectBinding.detail)}`,
	)
	lines.push(
		`Project config: ${report.projectConfig.status}${report.projectConfig.status === 'present' ? ` · ${formatBytes(report.projectConfig.logicalBytes)}` : ''} at ${safePath(report.projectConfig.path)}`,
	)
	if (report.legacyLocalConfig.status !== 'absent') {
		lines.push(
			`Earlier local settings file: ${report.legacyLocalConfig.status}${report.legacyLocalConfig.status === 'present' ? ` · ${formatBytes(report.legacyLocalConfig.logicalBytes)}` : ''} at ${safePath(report.legacyLocalConfig.path)}; read while this folder is trusted, and moved into .namzu/settings.local.json when a session starts here, unless git tracks it`,
		)
	}
	lines.push('No files were changed. Legacy state is reported, not declared safe to delete.')
	return lines.join('\n')
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	const units = ['KiB', 'MiB', 'GiB', 'TiB'] as const
	let value = bytes / 1024
	let unit: (typeof units)[number] = units[0]
	for (let index = 1; index < units.length && value >= 1024; index += 1) {
		value /= 1024
		unit = units[index] as (typeof units)[number]
	}
	return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`
}

function safePath(path: string): string {
	return safeLine(path)
}

function safeLine(text: string): string {
	return terminalDisplayText(text).replaceAll('\n', '\\n').replaceAll('\t', '\\t')
}
