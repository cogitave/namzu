import { type DoctorCheck, type DoctorCheckResult, referencedVariables } from '@namzu/sdk'

import { resolve } from 'node:path'

import { hookSwitch, hooksBySource } from '../../config/hook-layers.js'
import { LOCAL_CONFIG_FILE, hookConfigProblems, shortHomePath } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { isTrusted } from '../../integrations/trust/store.js'
import {
	hookConfigProblemLines,
	hookReadingProblems,
	hooksSwitchLine,
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
	lines.push('Plugin hooks are not counted here; plugins have their own switch (plugins.enabled).')
	return {
		status: unreadable.length > 0 || notLoaded || unsetVariables.length > 0 ? 'warn' : 'pass',
		message: lines.join(' '),
	}
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
					!KERNEL_NAME.test(name) &&
					!new RegExp(`(?<![A-Za-z0-9_$])${name}=`).test(texts.join(' ')),
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
		run: async (ctx) => describeHooksStatus(config, { cwd: ctx.cwd, trusted: isTrusted(ctx.cwd) }),
	}
}
