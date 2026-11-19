import { projectRelative, tildePath } from '../path-display.js'

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|[\\/])/

export interface FilePathParts {
	/** The last segment, which names the file. */
	name: string
	/** Everything before the name, ending in a slash, written for reading; empty for a bare name. */
	folder: string
}

/**
 * A changed file's path split for its row. Both `/` and `\` separate segments. A file outside the
 * project (an absolute path that does not start at the project folder) is written with the home
 * folder as `~`, so it reads the same on every system and carries no drive or user name.
 */
export function filePathParts(path: string, projectRoot?: string): FilePathParts {
	let shown = path.replace(/\\/g, '/')
	if (ABSOLUTE.test(path)) {
		const inside = projectRelative(path, projectRoot)
		shown = inside !== undefined && inside !== '.' ? inside : tildePath(path)
	}
	const name = shown.split('/').filter(Boolean).pop() || shown
	return { name, folder: shown.slice(0, shown.length - name.length) }
}
