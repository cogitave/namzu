import { EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import { type NamzuStateReport, inspectNamzuState } from '../integrations/state/report.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import type { CommandDef } from './types.js'

const HELP = `namzu state — inspect local Namzu state without changing it

Usage:
  namzu state
  namzu state report

Output:
  Use the global --format json or --format yaml flag for structured output.

This command does not load project configuration, create a Session, repair,
move, chmod, or delete state. Future mutating operations live under explicit
state subcommands; unknown subcommands are refused.

Options:
  -h, --help  Show this help`

export interface StateCommandDeps {
	readonly inspect: () => Promise<NamzuStateReport>
}

export function createStateCommand(deps: StateCommandDeps): CommandDef {
	return {
		name: 'state',
		description: 'Inspect local Namzu state without changing it',
		passThrough: true,
		help: HELP,
		handler: async ({ ctx, rawArgs }) => {
			if (!(rawArgs.length === 0 || (rawArgs.length === 1 && rawArgs[0] === 'report'))) {
				ctx.formatter.error({ message: 'Usage: namzu state [report]' })
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
		lines.push(
			`  sessions ${inventory.sessions.files} · runs ${inventory.runs.files} · checkpoints ${inventory.checkpointFiles.files} (${formatBytes(inventory.checkpointFiles.logicalBytes)})`,
		)
		if (inventory.emergencyDumpFiles.files > 0) {
			lines.push(
				`  emergency dumps ${inventory.emergencyDumpFiles.files} (${formatBytes(inventory.emergencyDumpFiles.logicalBytes)})`,
			)
		}
		if (inventory.attachments.files > 0) {
			lines.push(
				`  attachment files ${inventory.attachments.files} (${formatBytes(inventory.attachments.logicalBytes)}) · ${inventory.attachments.pairs} complete pairs · ${inventory.attachments.orphanedDataFiles + inventory.attachments.orphanedTypeFiles} orphan halves`,
			)
		}
		const candidates = inventory.originOnlySessionCandidates
		if (candidates.files > 0 || !candidates.complete) {
			lines.push(
				`  origin-only candidates ${candidates.files} (${formatBytes(candidates.logicalBytes)}) · analysis ${candidates.complete ? 'complete' : 'incomplete'}`,
			)
			lines.push(`    ${candidates.limitation}`)
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
	lines.push('No files were changed. Candidate state is not declared safe to delete.')
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
