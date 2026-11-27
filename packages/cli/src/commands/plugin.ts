import { resolve } from 'node:path'

import { planSettingChange } from '../config/setting-cli.js'
import { namzuHomePath } from '../integrations/state/home.js'
import { isTrusted } from '../integrations/trust/store.js'

import { EXIT_FAIL, EXIT_NOINPUT, EXIT_OK, EXIT_USAGE } from '../exit-codes.js'
import {
	type PluginValidationReport,
	validatePluginFolder,
} from '../integrations/plugins/validate.js'
import { createFormatter } from '../output/index.js'
import { askYesNo } from '../schedule/commands/confirm-prompt.js'
import { terminalDisplayText } from '../tui/terminal-display.js'
import { PLUGIN_ACTIONS } from './actions/small.js'
import {
	MARKETPLACE_VERBS,
	PLUGIN_INSTALL_HELP,
	PLUGIN_INSTALL_VERBS,
	type PluginInstallVerb,
	runMarketplace,
	runPluginInstall,
} from './plugin-install.js'
import {
	PLUGIN_RECORD_HELP,
	PLUGIN_RECORD_VERBS,
	type PluginRecordVerb,
	runPluginRecords,
} from './plugin-records.js'
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
	'Usage: namzu plugin validate [--json] [--] [path]',
	'       namzu plugin list | details <id> | enable <id> | disable <id>   (installed plugins)',
	'       namzu plugin install | uninstall | update | prune | marketplace   (see below)',
	'',
	'Check a plugin folder (default: the current folder) and every part it carries,',
	'without running anything from it: no hook, MCP server, command or script is',
	'started, no module is imported and nothing is fetched. Files are read inside',
	'the folder only; a reference that leaves it is reported and not followed.',
	'A hooks module is read, not run: the report lists the events it hooks, the',
	'calls it makes, and whether it runs commands, reads files or uses the network.',
	'',
	'Each problem names the file, the line when it is known, what is wrong and what',
	'the loader would do about it. An error is something that makes the loader',
	'refuse the plugin or skip a part; a warning loads but is very likely not what',
	'you meant.',
	'',
	'Options:',
	'  --json  Print one JSON report (version 1) on standard output and nothing else',
	'  --      End of options, for a folder whose name starts with a dash',
	'',
	'Exit status:',
	'  0   no problems',
	'  10  warnings only',
	'  1   at least one error',
	'  66  the folder could not be read',
	'  64  the command line is wrong',
	'',
	PLUGIN_RECORD_HELP,
	'',
	PLUGIN_INSTALL_HELP,
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
					? 'plugin needs a subcommand: validate, list, details, enable or disable. Run `namzu plugin --help`.'
					: `unknown plugin subcommand: ${sub}. The ones there are: validate, ${PLUGIN_RECORD_VERBS.join(', ')}, ${PLUGIN_INSTALL_VERBS.join(', ')}, marketplace (${MARKETPLACE_VERBS.join(', ')}).`,
		}
	}
	let json = false
	const paths: string[] = []
	let literal = false
	for (const arg of rest) {
		if (literal) paths.push(arg)
		else if (arg === '--') literal = true
		else if (arg === '--json') json = true
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
	if (report.hooksModule !== undefined) {
		const module = report.hooksModule
		if (module.status === 'refused') {
			lines.push(`hooks module ${oneLine(module.entry)} is not run:`)
			for (const line of module.summary.refused) lines.push(`  ${oneLine(line)}`)
		} else if (module.status === 'empty') {
			lines.push(
				`hooks module ${oneLine(module.entry)} is not loaded: it registers nothing Namzu runs.`,
			)
		} else {
			lines.push(
				`hooks module ${oneLine(module.entry)} runs in an isolated worker when the plugin is on:`,
			)
			for (const line of module.lines) lines.push(`  ${oneLine(line)}`)
		}
		for (const hook of module.hooks) {
			const flags = [hook.matcher ? 'with a matcher' : '', hook.catches ? 'with .catch' : '']
				.filter((flag) => flag !== '')
				.join(', ')
			lines.push(
				`  ${hook.runs ? 'hooks' : 'not used'}  ${oneLine(hook.pattern)}${flags ? ` (${flags})` : ''}  ${oneLine(hook.file)}:${hook.line}`,
			)
		}
		const calls = [...new Set(module.calls.map((call) => call.call))]
		if (calls.length > 0) lines.push(`  calls  ${calls.map(oneLine).join(', ')}`)
		// A warning above already says it once.
		for (const line of module.summary.notUsed) {
			if (report.problems.some((problem) => problem.message === line)) continue
			lines.push(`  not used  ${oneLine(line)}`)
		}
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
	description:
		'Check a plugin folder, install plugins from folders and files, and list, inspect, update and remove them',
	passThrough: true,
	help: HELP,
	actions: PLUGIN_ACTIONS,
	handler: async ({ ctx, rawArgs }) => {
		const verb = rawArgs[0]
		const isMarketplace = verb === 'marketplace'
		const isRecord = (PLUGIN_RECORD_VERBS as readonly string[]).includes(verb ?? '')
		const isInstall = (PLUGIN_INSTALL_VERBS as readonly string[]).includes(verb ?? '')
		if (isRecord || isInstall || isMarketplace) {
			const interactive = process.stdin.isTTY === true && process.stderr.isTTY === true
			const deps = {
				out: (text: string) => process.stdout.write(text),
				err: (text: string) => process.stderr.write(text),
				cwd: () => process.cwd(),
				namzuHome: namzuHomePath(),
				isTrusted: (dir: string) => isTrusted(dir),
				loadingOn: ctx.config.plugins?.enabled === true,
				interactive,
				ask: askYesNo,
				now: () => new Date(),
				enableLoading: () => {
					const plan = planSettingChange('plugins.enabled', 'true')
					if (!plan.ok) throw new Error(plan.error)
					return plan.apply().replace(/^Plugins is now/, 'Plugin loading is now')
				},
			}
			if (isRecord) return runPluginRecords(verb as PluginRecordVerb, rawArgs.slice(1), deps)
			return isMarketplace
				? runMarketplace(rawArgs.slice(1), deps)
				: runPluginInstall(verb as PluginInstallVerb, rawArgs.slice(1), deps)
		}
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
		} else if (report.status === 'unreadable') {
			// An error sentence, not output: a script that captures stdout gets none of it.
			ctx.formatter.error({ message: renderPluginReport(report) })
		} else {
			ctx.formatter.print({ text: renderPluginReport(report) })
		}
		return exitStatusFor(report)
	},
}
