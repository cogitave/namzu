import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { resolve } from 'node:path'

import { hookSwitch, hooksBySource } from '../../config/hook-layers.js'
import { LOCAL_CONFIG_FILE, shortHomePath } from '../../config/load.js'
import type { NamzuCliConfig } from '../../config/schema.js'
import { isTrusted } from '../../integrations/trust/store.js'
import { hookReadingProblems, hooksSwitchLine } from '../../tui/slashCommands.js'

/**
 * How many hooks are attached, from which file, and whether a switch is
 * limiting them.
 *
 * A `pass` unless a matcher or `if` cannot be read (then a `warn` names it): a
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
	lines.push(state === undefined ? 'No hook switch is on.' : `Switch on: ${hooksSwitchLine(state)}`)
	lines.push('Plugin hooks are not counted here; plugins have their own switch (plugins.enabled).')
	return { status: unreadable.length > 0 ? 'warn' : 'pass', message: lines.join(' ') }
}

export function hooksCheck(config: NamzuCliConfig): DoctorCheck {
	return {
		id: 'runtime.hooks',
		category: 'runtime',
		run: async (ctx) => describeHooksStatus(config, { cwd: ctx.cwd, trusted: isTrusted(ctx.cwd) }),
	}
}
