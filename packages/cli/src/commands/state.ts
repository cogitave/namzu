import { EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../exit-codes.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import {
	type LegacyMoveResult,
	moveProjectLegacyState,
} from '../integrations/state/project-legacy.js'
import { type NamzuStateReport, inspectNamzuState } from '../integrations/state/report.js'
import { homePath } from '../tui/person-terms.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import type { CommandDef } from './types.js'

const HELP = `namzu state — inspect local Namzu state, and move what an earlier Namzu left in a project

Usage:
  namzu state
  namzu state report
  namzu state move-legacy [--dry-run]

report (the default) lists what Namzu keeps and where, without changing
anything: it does not load project configuration, create a Session, repair,
move, chmod, or delete state.

move-legacy moves the state an earlier Namzu kept in this folder's .namzu
(sessions/, projects/, checkpoints/, worktrees/, cli.json and the like) into
the Namzu home, under legacy/<folder>/<time>/. It runs only in a folder you
trust, moves only names an earlier Namzu wrote, and leaves in place what git
tracks, a git worktree with changes and anything it cannot check, saying why.
--dry-run says what would move and changes nothing.

Output:
  Use the global --format json or --format yaml flag for structured output.

Options:
  --dry-run   With move-legacy: list what would move, change nothing
  -h, --help  Show this help`

export interface StateCommandDeps {
	readonly inspect: () => Promise<NamzuStateReport>
	readonly moveLegacy?: (options: { readonly dryRun: boolean }) => Promise<LegacyMoveResult>
}

export function createStateCommand(deps: StateCommandDeps): CommandDef {
	return {
		name: 'state',
		description: 'Inspect local Namzu state, or move what an earlier Namzu left in a project',
		passThrough: true,
		help: HELP,
		handler: async ({ ctx, rawArgs }) => {
			if (rawArgs[0] === 'move-legacy') {
				const rest = rawArgs.slice(1)
				if (!(rest.length === 0 || (rest.length === 1 && rest[0] === '--dry-run'))) {
					ctx.formatter.error({ message: 'Usage: namzu state move-legacy [--dry-run]' })
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
				ctx.formatter.error({ message: 'Usage: namzu state [report | move-legacy [--dry-run]]' })
				return EXIT_USAGE
			}
			const report = await deps.inspect()
			ctx.formatter.print({ ...report, text: renderStateReport(report) })
			return EXIT_OK
		},
	}
}

export const stateCommand: CommandDef = createStateCommand({
	inspect: inspectNamzuState,
})

/** What `namzu state move-legacy` says it did, or with `--dry-run` would do. */
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
					'  namzu state move-legacy moves it into the Namzu home (--dry-run lists what would move).',
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
