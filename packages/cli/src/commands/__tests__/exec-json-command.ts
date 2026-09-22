/**
 * `namzu exec --json` as a command of its own, for tests written against the
 * streaming mode: the same handler with `--json` in front of the arguments.
 */
import { execCommand } from '../exec.js'
import type { CommandDef } from '../types.js'

export const execJsonCommand: CommandDef = {
	...execCommand,
	handler: (args) => execCommand.handler({ ...args, rawArgs: ['--json', ...args.rawArgs] }),
}
