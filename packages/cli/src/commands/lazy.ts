import type { CommandDef } from './types.js'

/**
 * What commander needs to list a command and to route to it, without the
 * module that runs it.
 *
 * `namzu --version`, `namzu --help` and the usage error for a mistyped
 * command are answered by commander before any action runs, from nothing but
 * each command's name, aliases, description and whether it passes its
 * arguments through. A command that carried its handler in its definition
 * made all of them compile every command module and the SDK behind them
 * first: about 400 ms to print a version number. This is the definition
 * without the handler; `load` fetches the real one the first time the
 * command is run, or its `--help` is asked for.
 */
export interface LazyCommandDef
	extends Pick<CommandDef, 'name' | 'aliases' | 'description' | 'passThrough'> {
	readonly load: () => Promise<CommandDef>
}

export function lazyCommand(
	meta: Pick<CommandDef, 'name' | 'aliases' | 'description' | 'passThrough'>,
	load: () => Promise<CommandDef>,
): LazyCommandDef {
	let loaded: Promise<CommandDef> | undefined
	return {
		...meta,
		// One import however many times it is asked, and a failed one is asked
		// again rather than remembered.
		load: () => {
			if (!loaded) {
				loaded = load().catch((error: unknown) => {
					loaded = undefined
					throw error
				})
			}
			return loaded
		},
	}
}

export function isLazyCommand(def: CommandDef | LazyCommandDef): def is LazyCommandDef {
	return 'load' in def
}
