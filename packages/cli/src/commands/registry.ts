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
				const code = await def.handler({
					ctx: opts.getContext(),
					rawArgs: args ?? [],
				})
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
