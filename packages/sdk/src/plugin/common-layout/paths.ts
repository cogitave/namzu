import {
	COMMON_DATA_VARIABLE,
	COMMON_PROJECT_VARIABLE,
	COMMON_ROOT_VARIABLE,
	NAMZU_DATA_VARIABLE,
	NAMZU_PROJECT_VARIABLE,
	NAMZU_ROOT_VARIABLE,
} from '../common-layout-names.js'

/** The folders the six path names stand for. A name with no folder here is left as written. */
export interface PluginPathValues {
	/** The plugin's own folder. */
	readonly root: string
	/** The folder kept for the plugin's data. */
	readonly data?: string | undefined
	/** The folder the session was started for. */
	readonly project?: string | undefined
}

/** The six names {@link expandPluginPaths} replaces, and nothing else. */
export const PLUGIN_PATH_VARIABLES: readonly string[] = [
	COMMON_ROOT_VARIABLE,
	NAMZU_ROOT_VARIABLE,
	COMMON_DATA_VARIABLE,
	NAMZU_DATA_VARIABLE,
	COMMON_PROJECT_VARIABLE,
	NAMZU_PROJECT_VARIABLE,
]

export interface ExpandedPaths {
	readonly text: string
	/** Path names that had no folder to stand for, in order of appearance. */
	readonly unresolved: readonly string[]
}

function folderFor(name: string, values: PluginPathValues): string | undefined {
	if (name === COMMON_ROOT_VARIABLE || name === NAMZU_ROOT_VARIABLE) return values.root
	if (name === COMMON_DATA_VARIABLE || name === NAMZU_DATA_VARIABLE) return values.data
	if (name === COMMON_PROJECT_VARIABLE || name === NAMZU_PROJECT_VARIABLE) return values.project
	return undefined
}

/**
 * `${NAME}` for exactly the six path names becomes the folder. Nothing runs a
 * shell and nothing else is touched: `$NAME`, `${OTHER}` and `${NAME:-x}` are
 * left as written. A folder that is not absolute, or holds a NUL, is refused
 * with a thrown reason, so a substituted value never turns into a relative
 * or truncated path.
 */
export function expandPluginPaths(text: string, values: PluginPathValues): ExpandedPaths {
	const unresolved: string[] = []
	const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole: string, name: string) => {
		if (!PLUGIN_PATH_VARIABLES.includes(name)) return whole
		const folder = folderFor(name, values)
		if (folder === undefined) {
			unresolved.push(name)
			return whole
		}
		if (folder.includes('\0') || !/^([A-Za-z]:[\\/]|[\\/])/.test(folder)) {
			throw new Error(`The folder for ${name} must be an absolute path without NUL characters.`)
		}
		return folder
	})
	return { text: out, unresolved }
}

/** Only the plugin's own folder: the form skill, command and agent text gets. */
export function expandPluginRootText(text: string, root: string): string {
	return expandPluginPaths(text, { root }).text
}
