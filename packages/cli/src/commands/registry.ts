import type { Command } from 'commander'

import type { CommandContext, CommandDef } from './types.js'

export interface RegisterOptions {
	/** Lazily-resolved command context — built only after global flags are parsed. */
	readonly getContext: () => CommandContext
	/** Callback the registry uses to surface an action handler's return code. */
	readonly setExitCode: (code: number) => void
}

export function registerCommand(program: Command, def: CommandDef, opts: RegisterOptions): void {
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
				if (def.help !== undefined && rawArgs.some((a) => a === '--help' || a === '-h')) {
					opts.getContext().formatter.print({ text: def.help })
					opts.setExitCode(0)
					return
				}

				const code = await def.handler({ ctx: opts.getContext(), rawArgs })
				opts.setExitCode(code)
			})
	} else {
		cmd.action(async () => {
			const code = await def.handler({ ctx: opts.getContext(), rawArgs: [] })
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
