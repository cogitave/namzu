import { resolve } from 'node:path'

import { EXIT_FAIL, EXIT_NOINPUT, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	type PluginValidationReport,
	validatePluginFolder,
} from '../integrations/plugins/validate.js'
import { createFormatter } from '../output/index.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import type { CommandDef } from './types.js'

/**
 * `namzu plugin validate` exit statuses. Warnings get their own number so a
 * script can tell "loads, but check it" from both a clean plugin and a broken
 * one; 66 is sysexits EX_NOINPUT, "the folder could not be read".
 */
export const PLUGIN_VALIDATE_EXIT = {
	clean: EXIT_OK,
	errors: EXIT_FAIL,
	warnings: 10,
	unreadable: EXIT_NOINPUT,
	usage: EXIT_USAGE,
} as const

const HELP = [
	'Usage: namzu plugin validate [path] [--json]',
	'',
	'Check a plugin folder (default: the current folder) and every part it carries,',
	'without running anything from it: no hook, MCP server, command or script is',
	'started, no module is imported and nothing is fetched. Files are read inside',
	'the folder only; a reference that leaves it is reported and not followed.',
	'',
	'Each problem names the file, the line when it is known, what is wrong and what',
	'the loader would do about it. An error is something that makes the loader',
	'refuse the plugin or skip a part; a warning loads but is very likely not what',
	'you meant.',
	'',
	'Options:',
	'  --json  Print one JSON report (version 1) on standard output and nothing else',
	'',
	'Exit status:',
	'  0   no problems',
	'  10  warnings only',
	'  1   at least one error',
	'  66  the folder could not be read',
	'  64  the command line is wrong',
].join('\n')

interface ParsedArgs {
	readonly path: string
	readonly json: boolean
	readonly error?: string
}

function parseArgs(rawArgs: readonly string[]): ParsedArgs {
	const [sub, ...rest] = rawArgs
	if (sub !== 'validate') {
		return {
			path: '.',
			json: false,
			error:
				sub === undefined
					? 'plugin needs a subcommand: validate. Run `namzu plugin --help`.'
					: `unknown plugin subcommand: ${sub}. The one there is: validate.`,
		}
	}
	let json = false
	const paths: string[] = []
	for (const arg of rest) {
		if (arg === '--json') json = true
		else if (arg.startsWith('-') && arg !== '-') {
			return { path: '.', json, error: `unknown plugin validate option: ${arg}` }
		} else paths.push(arg)
	}
	if (paths.length > 1) {
		return { path: '.', json, error: 'plugin validate takes one folder at a time.' }
	}
	return { path: paths[0] ?? '.', json }
}

export function exitStatusFor(report: PluginValidationReport): number {
	switch (report.status) {
		case 'clean':
			return PLUGIN_VALIDATE_EXIT.clean
		case 'warnings':
			return PLUGIN_VALIDATE_EXIT.warnings
		case 'errors':
			return PLUGIN_VALIDATE_EXIT.errors
		default:
			return PLUGIN_VALIDATE_EXIT.unreadable
	}
}

function oneLine(value: string): string {
	return terminalDisplayText(value).replace(/[\t\n\r]+/g, ' ')
}

export function renderPluginReport(report: PluginValidationReport): string {
	if (report.status === 'unreadable') {
		return `Could not read ${oneLine(report.folder)}: ${oneLine(report.readError ?? 'unknown reason')}`
	}
	const who = report.plugin.name
		? `${oneLine(report.plugin.name)} ${oneLine(report.plugin.version ?? '')}`.trim()
		: 'plugin'
	const lines = [`Checked ${who} in ${oneLine(report.folder)}`]
	for (const problem of report.problems) {
		const where = problem.file
			? `${oneLine(problem.file)}${problem.line !== undefined ? `:${problem.line}` : ''}`
			: ''
		lines.push(
			`${problem.level === 'error' ? 'error  ' : 'warning'}  ${where ? `${where}  ` : ''}${oneLine(problem.message)}`,
		)
		lines.push(`         ${oneLine(problem.consequence)}`)
	}
	const parts = `${report.parts.length} ${report.parts.length === 1 ? 'part' : 'parts'}`
	const { errors, warnings } = report.summary
	lines.push(
		errors === 0 && warnings === 0
			? `No problems in ${parts}.`
			: `${parts} checked: ${errors} ${errors === 1 ? 'error' : 'errors'}, ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}.`,
	)
	return lines.join('\n')
}

export const pluginCommand: CommandDef = {
	name: 'plugin',
	description: 'Check a plugin folder without running anything from it',
	passThrough: true,
	help: HELP,
	handler: async ({ ctx, rawArgs }) => {
		const args = parseArgs(rawArgs)
		if (args.error) {
			ctx.formatter.error({ message: args.error })
			return PLUGIN_VALIDATE_EXIT.usage
		}
		const report = await validatePluginFolder(resolve(args.path))
		// `--json` (or the global `--format json`) is this command's own shape,
		// printed by the JSON formatter with nothing beside it; the text report
		// goes through whichever formatter the person chose.
		if (args.json || ctx.formatter.name === 'json') {
			createFormatter('json', { quiet: true }).print(report)
		} else if (ctx.formatter.name === 'yaml') {
			ctx.formatter.print(report)
		} else {
			ctx.formatter.print({ text: renderPluginReport(report) })
		}
		return exitStatusFor(report)
	},
}
