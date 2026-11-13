/**
 * The environment a shell hook command is started with, beyond what the
 * kernel always sets: the entry's own `env` map, and variables a moved
 * command expects.
 *
 * A hooks block brought from elsewhere often starts a command with a variable
 * for the project folder, named for the tool it was written for. That tool's
 * name is not ours to know, so the rule here reads the shape of the name: a
 * variable the command or its arguments refer to, that is not set, and whose
 * name ends in one of {@link MOVED_FOLDER_ENDINGS}, is set to that folder.
 * Nothing already set is ever replaced.
 */

/** A name a hook is started with that `env` may not replace: the kernel sets these itself. */
export const SHELL_HOOK_RESERVED_ENV: readonly string[] = [
	'NAMZU_HOOK_EVENT',
	'NAMZU_SESSION_ID',
	'NAMZU_PROJECT_DIR',
	'NAMZU_TURN_ID',
	'NAMZU_TOOL_NAME',
	'NAMZU_TOOL_PATH',
	'NAMZU_STARTED_BY_SESSION',
]

/** The folders a name's ending can stand for. */
export type MovedFolder = 'project' | 'plugin' | 'pluginData'

/** Endings read by shape; the name looked for is the whole variable name. */
export const MOVED_FOLDER_ENDINGS: readonly {
	readonly ending: string
	readonly folder: MovedFolder
}[] = [
	{ ending: '_PROJECT_DIR', folder: 'project' },
	// A plugin's own folder and the folder kept for its data. These are set only
	// for a hook entry a plugin ships; a name like this in a config file's entry
	// has no folder to stand for and is left unset (and reported).
	{ ending: '_PLUGIN_ROOT', folder: 'plugin' },
	{ ending: '_PLUGIN_DATA', folder: 'pluginData' },
]

/** The folders a plugin-shipped entry is given. */
export interface PluginFolders {
	/** The plugin's own folder. */
	readonly root: string
	/** The folder kept for the plugin's data, under the Namzu home and never inside `root`. */
	readonly dataDir: string
}

/** Whether a variable name stands for a plugin folder by its ending. */
export function isPluginFolderVariable(name: string): boolean {
	return MOVED_FOLDER_ENDINGS.some(
		(each) =>
			(each.folder === 'plugin' || each.folder === 'pluginData') && name.endsWith(each.ending),
	)
}

/**
 * `${NAME}` and `$NAME` in a command or argument, for a name that ends in
 * `_PLUGIN_ROOT` or `_PLUGIN_DATA`, become the folder's path, so an entry in
 * the exec form (which no shell reads) finds its own folder too. A reference
 * with a modifier (`${NAME:-x}`) is left to the shell, which has the variable.
 */
export function substitutePluginFolders(text: string, folders: PluginFolders | undefined): string {
	if (folders === undefined) return text
	return text.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(whole: string, braced: string | undefined, bare: string | undefined) => {
			const name = (braced ?? bare) as string
			const moved = MOVED_FOLDER_ENDINGS.find((each) => name.endsWith(each.ending))
			if (moved === undefined) return whole
			if (moved.folder === 'plugin') return folders.root
			if (moved.folder === 'pluginData') return folders.dataDir
			return whole
		},
	)
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** What is wrong with an `env` name, or `undefined` when it can be used. */
export function shellHookEnvNameProblem(name: string): string | undefined {
	if (!NAME.test(name)) {
		return 'is not a valid variable name (letters, digits and underscores, not starting with a digit)'
	}
	if (SHELL_HOOK_RESERVED_ENV.includes(name)) {
		return 'is set by Namzu for every hook and cannot be replaced'
	}
	return undefined
}

/** The problems in an `env` value as a whole, each naming the variable. Empty when it is usable. */
export function shellHookEnvProblems(env: unknown): string[] {
	if (env === null || typeof env !== 'object' || Array.isArray(env)) {
		return ['must be a mapping of variable names to text']
	}
	const problems: string[] = []
	for (const [name, value] of Object.entries(env)) {
		const bad = shellHookEnvNameProblem(name)
		if (bad !== undefined) problems.push(`${JSON.stringify(name)} ${bad}`)
		else if (typeof value !== 'string') problems.push(`${JSON.stringify(name)} must be text`)
	}
	return problems
}

// `$NAME`, `${NAME}` and `${NAME<modifier>}`: group 2 is the modifier text.
const REFERENCE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g

/**
 * The variables the texts refer to, in order of first appearance. A reference
 * with a default (`${NAME:-x}`, `${NAME-x}`, `${NAME:+x}`, `${NAME=x}`) is
 * left out unless `withDefaults` is set: it works without the variable.
 */
export function referencedVariables(
	texts: readonly string[],
	options: { readonly withDefaults?: boolean } = {},
): string[] {
	const seen = new Set<string>()
	for (const text of texts) {
		for (const match of text.matchAll(REFERENCE)) {
			const name = match[1] ?? match[3]
			if (name === undefined) continue
			const modifier = match[2] ?? ''
			const hasDefault = /^:?[-+=]/.test(modifier)
			if (hasDefault && options.withDefaults !== true) continue
			seen.add(name)
		}
	}
	return [...seen]
}

/** Whether the command text itself gives the variable a value (`NAME=...`, `for NAME in`, `read NAME`). */
function assignedWithin(texts: readonly string[], name: string): boolean {
	const assign = new RegExp(`(?<![A-Za-z0-9_$])${name}=`)
	const loop = new RegExp(`\\bfor\\s+${name}\\b`)
	const read = new RegExp(`\\bread\\s+(?:-\\w+\\s+)*(?:[A-Za-z_][A-Za-z0-9_]*\\s+)*${name}\\b`)
	return texts.some((text) => assign.test(text) || loop.test(text) || read.test(text))
}

/** `$NAME` and `${NAME}` in an `env` value become the value the hook already has; any other text stays as written. */
export function expandHookEnvValue(
	value: string,
	have: Readonly<Record<string, string | undefined>>,
): string {
	return value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(whole: string, braced: string | undefined, bare: string | undefined) => {
			const found = have[(braced ?? bare) as string]
			return found === undefined ? whole : found
		},
	)
}

export interface MovedEnvironment {
	/** The environment to start the command with. */
	readonly env: Record<string, string | undefined>
	/** Variables the command refers to that are set nowhere (and not by the command itself). */
	readonly unset: readonly string[]
}

/**
 * Layer the entry's `env` map and the by-shape variables over `base` (the
 * inherited environment with the kernel's own variables). `kernel` holds the
 * variables the kernel always sets; they are applied last and win.
 */
export function movedEnvironment(
	entry: { readonly command: string; readonly args?: readonly string[]; readonly env?: unknown },
	base: Readonly<Record<string, string | undefined>>,
	kernel: Readonly<Record<string, string | undefined>>,
	folders: Readonly<Partial<Record<MovedFolder, string>>>,
): MovedEnvironment {
	const env: Record<string, string | undefined> = { ...base }
	if (entry.env !== null && typeof entry.env === 'object' && !Array.isArray(entry.env)) {
		for (const [name, value] of Object.entries(entry.env)) {
			if (shellHookEnvNameProblem(name) !== undefined || typeof value !== 'string') continue
			env[name] = expandHookEnvValue(value, base)
		}
	}
	Object.assign(env, kernel)
	const texts = [entry.command, ...(entry.args ?? [])]
	const unset: string[] = []
	for (const name of referencedVariables(texts)) {
		if (env[name] !== undefined) continue
		const moved = MOVED_FOLDER_ENDINGS.find((each) => name.endsWith(each.ending))
		const folder = moved === undefined ? undefined : folders[moved.folder]
		if (folder !== undefined) env[name] = folder
		else if (!assignedWithin(texts, name)) unset.push(name)
	}
	return { env, unset }
}

/**
 * The sentence added to a hook's failure when it could not find what it ran
 * and its command refers to variables that are set nowhere; `undefined` when
 * the failure does not look like a missing program or file, or nothing is unset.
 */
export function hookUnsetVariableHint(outcome: {
	readonly exitCode: number | null
	readonly stderr: string
	readonly spawnError?: string
	readonly unsetVariables?: readonly string[]
}): string | undefined {
	const unset = outcome.unsetVariables ?? []
	if (unset.length === 0) return undefined
	const notFound =
		(outcome.spawnError !== undefined && /ENOENT/.test(outcome.spawnError)) ||
		outcome.exitCode === 127 ||
		/no such file|not found/i.test(outcome.stderr)
	if (!notFound) return undefined
	const shown = unset.slice(0, 3).map((name) => `$${name}`)
	const more = unset.length > 3 ? ` and ${unset.length - 3} more` : ''
	return `its command refers to ${shown.join(', ')}${more}, which ${
		unset.length === 1 ? 'is' : 'are'
	} not set for hooks: give ${unset.length === 1 ? 'it' : 'each'} a value with the entry's "env" key`
}
