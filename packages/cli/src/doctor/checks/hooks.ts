import {
	type DoctorCheck,
	type DoctorCheckResult,
	assignedWithin,
	isPluginFolderVariable,
	isShellOwnVariable,
	referencedVariables,
} from '@namzu/sdk'

import { resolve } from 'node:path'

import { hookSwitch, hooksBySource } from '../../config/hook-layers.js'
import { LOCAL_CONFIG_FILE, hookConfigProblems, shortHomePath } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import {
	type PluginHookSummary,
	summarizePluginHooks,
} from '../../integrations/plugins/hook-entries.js'
import { PluginSettingsStore } from '../../integrations/plugins/settings.js'
import { resolveNamzuHome } from '../../integrations/state/home.js'
import { isTrusted } from '../../integrations/trust/store.js'
import {
	hookConfigProblemLines,
	hookReadingProblems,
	hooksSwitchLine,
	pluginHookProblemLines,
} from '../../tui/slashCommands.js'

/**
 * How many hooks are attached, from which file, and whether a switch is
 * limiting them.
 *
 * A `pass` unless a matcher or `if` cannot be read, or a hook a file declared could not be loaded (then a `warn` names it): a
 * switch is something a person chose, and no hooks is a healthy state. The row exists so that "which of my hooks are running,
 * and from where" has an answer that does not need a conversation.
 */
export function describeHooksStatus(
	config: NamzuCliConfig,
	folder?: { readonly cwd: string; readonly trusted: boolean },
	/** The hook entries the plugins on disk ship; absent, plugins are not described. */
	plugins?: PluginHookSummary,
): DoctorCheckResult {
	const bySource = new Map(hooksBySource(config.hooks))
	// A project's files attach their hooks only once the folder is trusted; the
	// config this run read does not know that, so the row does not count them.
	let untrusted = 0
	if (folder && !folder.trusted) {
		for (const file of ['namzu.config.json', LOCAL_CONFIG_FILE]) {
			const label = shortHomePath(resolve(folder.cwd, file))
			untrusted += bySource.get(label) ?? 0
			bySource.delete(label)
		}
	}
	const total = [...bySource.values()].reduce((sum, count) => sum + count, 0)
	const state = hookSwitch(config)
	const lines: string[] = []
	if (total === 0) lines.push('No shell hooks are attached.')
	else {
		lines.push(
			`${total} shell ${total === 1 ? 'hook is' : 'hooks are'} attached: ${[...bySource]
				.map(([source, count]) => `${count} from ${source}`)
				.join(', ')}.`,
		)
	}
	if (untrusted > 0) {
		lines.push(
			`${untrusted} more ${untrusted === 1 ? 'is' : 'are'} declared in this folder's files and not attached, because the folder is not trusted.`,
		)
	}
	const unreadable: string[] = []
	for (const [event, entries] of Object.entries(config.hooks ?? {})) {
		for (const entry of entries ?? []) {
			if (entry.source !== undefined && !bySource.has(entry.source)) continue
			for (const problem of hookReadingProblems(entry)) unreadable.push(`${event}: ${problem}`)
		}
	}
	for (const each of unreadable) lines.push(`Cannot be read: ${each}.`)
	const unsetVariables = unsetVariableLines(config, bySource)
	for (const each of unsetVariables) lines.push(each)
	// What a file declared and this kernel could not load, or read but does not act on.
	const untrustedLabels =
		folder && !folder.trusted
			? new Set(
					['namzu.config.json', LOCAL_CONFIG_FILE].map((file) =>
						shortHomePath(resolve(folder.cwd, file)),
					),
				)
			: new Set<string>()
	const declared = hookConfigProblems().filter((problem) => !untrustedLabels.has(problem.file))
	for (const line of hookConfigProblemLines(declared)) lines.push(line)
	const notLoaded = declared.some((problem) => problem.severity === 'problem')
	lines.push(state === undefined ? 'No hook switch is on.' : `Switch on: ${hooksSwitchLine(state)}`)
	lines.push(
		"Plugins' JavaScript hooks are not counted here; plugins have their own switch (plugins.enabled).",
	)
	const shipped = describePluginEntries(plugins, state)
	for (const each of shipped.lines) lines.push(each)
	return {
		status:
			unreadable.length > 0 || notLoaded || unsetVariables.length > 0 || shipped.warn
				? 'warn'
				: 'pass',
		message: lines.join(' '),
	}
}

/**
 * The hook entries plugins ship: how many are attached, from which plugin, how
 * many are not (the plugin is off, or a switch is on), and what could not be
 * loaded. A plugin's entries run only while the plugin is on, and `disableHooks`
 * and `hooksManagedOnly` turn them off.
 */
function describePluginEntries(
	summary: PluginHookSummary | undefined,
	state: ReturnType<typeof hookSwitch>,
): { readonly lines: string[]; readonly warn: boolean } {
	if (summary === undefined) return { lines: [], warn: false }
	const lines: string[] = []
	const withEntries = summary.plugins.filter((plugin) => plugin.count > 0)
	const attached = state === undefined ? withEntries.filter((plugin) => plugin.enabled) : []
	const total = attached.reduce((sum, plugin) => sum + plugin.count, 0)
	if (summary.unreadProjectPlugins > 0) {
		lines.push(
			`${summary.unreadProjectPlugins} plugin${summary.unreadProjectPlugins === 1 ? '' : 's'} in this folder ${summary.unreadProjectPlugins === 1 ? 'is' : 'are'} not read, because the folder is not trusted; what ${summary.unreadProjectPlugins === 1 ? 'it ships' : 'they ship'} is not counted here.`,
		)
	}
	if (withEntries.length === 0) lines.push('No plugin ships hook entries.')
	else {
		lines.push(
			`${total} plugin hook ${total === 1 ? 'entry is' : 'entries are'} attached${
				total > 0
					? `: ${attached.map((plugin) => `${plugin.count} from plugin ${plugin.name}`).join(', ')}`
					: ''
			}.`,
		)
		const off = withEntries.filter((plugin) => !attached.includes(plugin))
		if (off.length > 0) {
			const count = off.reduce((sum, plugin) => sum + plugin.count, 0)
			const why =
				state === undefined
					? 'the plugin is off'
					: state === 'managed-only'
						? 'hooksManagedOnly is on and no plugin comes from the managed file'
						: 'disableHooks is on'
			lines.push(
				`${count} more ${count === 1 ? 'is' : 'are'} not attached (${why}): ${off.map((plugin) => plugin.name).join(', ')}.`,
			)
		}
	}
	const problems = summary.plugins.flatMap((plugin) =>
		plugin.problems.map((problem) => ({ ...problem, plugin: plugin.name })),
	)
	for (const line of pluginHookProblemLines(problems)) lines.push(line)
	return { lines, warn: problems.some((problem) => problem.severity === 'problem') }
}

/** Names Namzu sets for a hook itself. */
const KERNEL_NAME = /^NAMZU_(HOOK_EVENT|SESSION_ID|TURN_ID|TOOL_NAME|TOOL_PATH|STARTED_BY_SESSION)$/

/**
 * A hook whose command refers to a variable that is set nowhere will not find
 * what it expects. A name ending in `_PROJECT_DIR` is filled in when the hook
 * runs, one the entry's `env` gives is set, and one the command gives a default
 * or assigns itself works as it is; the rest are said here.
 */
function unsetVariableLines(
	config: NamzuCliConfig,
	attached: ReadonlyMap<string, number>,
): string[] {
	const lines: string[] = []
	for (const [event, entries] of Object.entries(config.hooks ?? {})) {
		for (const entry of entries ?? []) {
			if (entry.source !== undefined && !attached.has(entry.source)) continue
			if (entry.type !== undefined) continue
			const texts = [entry.command, ...(entry.args ?? [])]
			const missing = referencedVariables(texts).filter(
				(name) =>
					process.env[name] === undefined &&
					entry.env?.[name] === undefined &&
					!MOVED_ENDING.test(name) &&
					!(entry.source?.startsWith('plugin ') === true && isPluginFolderVariable(name)) &&
					!KERNEL_NAME.test(name) &&
					!isShellOwnVariable(name) &&
					!assignedWithin(texts, name),
			)
			if (missing.length === 0) continue
			const names = missing.map((name) => `$${name}`).join(', ')
			lines.push(
				`${event}: the command \`${entry.command.slice(0, 60)}\` refers to ${names}, which ${missing.length === 1 ? 'is' : 'are'} not set; give ${missing.length === 1 ? 'it' : 'each'} a value with the entry's "env" key.`,
			)
		}
	}
	return lines
}

const MOVED_ENDING = /.+_PROJECT_DIR$/

export function hooksCheck(config: NamzuCliConfig): DoctorCheck {
	return {
		id: 'runtime.hooks',
		category: 'runtime',
		run: async (ctx) => {
			const trusted = isTrusted(ctx.cwd)
			// What the plugins on disk ship: a plugin is read only when plugins are on, and
			// a project plugin only when the folder is trusted.
			let plugins: PluginHookSummary | undefined
			if (config.plugins?.enabled === true) {
				const home = resolveNamzuHome()
				const settings = new PluginSettingsStore(home)
				try {
					plugins = await summarizePluginHooks({
						cwd: ctx.cwd,
						home,
						allowedScopes: config.plugins.allowedScopes ?? ['project', 'user'],
						autoDiscovery: config.plugins.autoDiscovery ?? true,
						trusted,
						enabled: (plugin) => settings.read(plugin),
					})
				} catch {
					plugins = undefined
				}
			}
			return describeHooksStatus(config, { cwd: ctx.cwd, trusted }, plugins)
		},
	}
}
