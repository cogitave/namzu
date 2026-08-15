import type { NamzuCliConfig } from '../config/schema.js'
import type { ResolvedLogging } from '../logging.js'
import type { Formatter } from '../output/index.js'

export interface CommandContext {
	readonly formatter: Formatter
	readonly config: NamzuCliConfig
	/**
	 * `--verbose`/`--quiet`/`NAMZU_LOG_LEVEL` and `--log-format`/
	 * `NAMZU_LOG_FORMAT`, resolved once in `cli.ts#getContext()` — flag
	 * beating env, per `../logging.ts`. Optional so a `ctx` a test built by
	 * hand without a `logging` field does not have to grow one just to keep
	 * compiling; `contextLogging()` gives such a handler the same default
	 * `getContext()` would have produced with no flags set.
	 */
	readonly logging?: ResolvedLogging
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
	/**
	 * Help text for a passThrough command that does not render its own.
	 *
	 * `passThrough` turns commander's `--help` off so a command can parse
	 * it itself. A command that does not then receives `--help` as INPUT —
	 * it becomes the prompt to run, or the query to search — and a user
	 * asking how to use something gets a credential error or an empty
	 * result list instead of an answer.
	 *
	 * Set this and the registry answers `--help` before the handler runs.
	 * Leave it unset only when the command genuinely renders its own.
	 */
	readonly help?: string
	readonly handler: CommandHandler
}
