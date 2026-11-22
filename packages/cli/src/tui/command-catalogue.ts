import type { CommandCatalogueEntry } from './command-tool.js'
import {
	CLI_LOCAL_COMMANDS,
	type SlashCommand,
	kernelCommandDescriptors,
	mergeHostCommands,
} from './slashCommands.js'

/** The built-in commands as the catalogue the `command` tool reads. */
export function builtinCommandCatalogue(
	commands: readonly SlashCommand[] = mergeHostCommands(
		kernelCommandDescriptors(),
		CLI_LOCAL_COMMANDS,
	),
): readonly CommandCatalogueEntry[] {
	return commands.map((command) => ({
		name: command.name,
		description: command.description,
		...(command.modelRun !== undefined ? { modelRun: command.modelRun } : {}),
		source: 'builtin' as const,
		...(command.discoverable === false ? { hidden: true as const } : {}),
	}))
}
