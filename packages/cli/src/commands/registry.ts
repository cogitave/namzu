import type { Command } from 'commander'

import { renderActionIndex, resolveActionHelp } from './action-help.js'
import { type LazyCommandDef, isLazyCommand } from './lazy.js'
import type { CommandContext, CommandDef } from './types.js'

export interface RegisterOptions {
	/** Lazily-resolved command context — built only after global flags are parsed. */
	readonly getContext: () => CommandContext
	/** Callback the registry uses to surface an action handler's return code. */
	readonly setExitCode: (code: number) => void
}

export function registerCommand(program: Command, def: CommandDef, opts: RegisterOptions): void {
	registerCommandOrLazy(program, def, opts)
}

/**
 * Register `def` on `program`. A lazy definition carries only what commander
 * lists; its module is imported when the command runs, so `--version`,
 * `--help` and a usage error never load it.
 *
 * Kept apart from `registerCommand` so the package's public signature does
 * not name the lazy definition, which is the command shell's own business.
 */
export function registerCommandOrLazy(
	program: Command,
	def: CommandDef | LazyCommandDef,
	opts: RegisterOptions,
): void {
	const resolve = async (): Promise<CommandDef> => (isLazyCommand(def) ? def.load() : def)
	const cmd = program.command(def.name).description(def.description)

	if (def.passThrough) {
		cmd
			.helpOption(false)
			.allowUnknownOption(true)
			.passThroughOptions(true)
			.argument('[args...]')
			.action(async (args: string[] | undefined) => {
				const rawArgs = args ?? []

				// `helpOption(false)` hands `--help` to the command, which is
				// right for one that renders its own. A command that does not
				// used to receive `--help` as INPUT: it became the prompt to
				// run, or the query to search, and the user asking how to use
				// something got a credential error or an empty result list.
				// Three commands did this. Handling it here rather than in
				// each one is what stops the fourth from doing it too.
				const real = await resolve()
				// Words after a literal `--` belong to a command being
				// registered (`mcp add x -- npx server --help`), not to us.
				const dash = rawArgs.indexOf('--')
				const head = dash === -1 ? rawArgs : rawArgs.slice(0, dash)
				if (real.help !== undefined && head.some((a) => a === '--help' || a === '-h')) {
					const actions = real.actions
					const text =
						actions === undefined
							? real.help
							: (resolveActionHelp(real.name, actions, rawArgs) ??
								`${real.help.trimEnd()}\n\n${renderActionIndex(real.name, actions)}`)
					opts.getContext().formatter.print({ text })
					opts.setExitCode(0)
					return
				}

				const code = await real.handler({ ctx: opts.getContext(), rawArgs })
				opts.setExitCode(code)
			})
	} else {
		cmd.action(async () => {
			const real = await resolve()
			const code = await real.handler({ ctx: opts.getContext(), rawArgs: [] })
			opts.setExitCode(code)
		})
	}
}

export function registerAll(
	program: Command,
	defs: readonly CommandDef[],
	opts: RegisterOptions,
): void {
	for (const def of defs) registerCommand(program, def, opts)
}
