import type { NamzuCliConfig } from '../config/schema.js'
import type { Formatter } from '../output/index.js'

export interface CommandContext {
	readonly formatter: Formatter
	readonly config: NamzuCliConfig
}

export interface CommandHandlerArgs {
	readonly ctx: CommandContext
	/** Raw post-command arguments, untouched. Only populated for passThrough commands. */
	readonly rawArgs: readonly string[]
}

export type CommandHandler = (args: CommandHandlerArgs) => Promise<number>

export interface CommandDef {
	readonly name: string
	readonly description: string
	/**
	 * When true, command-level option parsing is disabled. All arguments after
	 * the command name are forwarded to the handler via `rawArgs`. The command
	 * is responsible for its own --help. Used by `doctor` to preserve its
	 * pre-Commander argument parsing contract.
	 */
	readonly passThrough?: boolean
	readonly handler: CommandHandler
}
