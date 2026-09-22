import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * The session's added directories: the ones `/add-dir` extends and every turn
 * reads fresh — the query, the sandbox binds and the environment prompt.
 */
export interface SessionDirectories {
	list(): readonly string[]
	/**
	 * Add one for the rest of the session.
	 *
	 * A directory outside the working directory is added only when `approve`
	 * answers yes for its absolute path. Adding one lets every file tool reach
	 * it with no further question, which is exactly the question a path there
	 * otherwise gets, so the user is asked once here instead. Without an
	 * `approve` such a directory is refused: an add that nobody confirmed is
	 * not one this session makes on its own.
	 */
	add(
		path: string,
		options?: { readonly approve?: (absolute: string) => Promise<boolean> },
	): Promise<{
		readonly added: boolean
		readonly path: string
		readonly reason?: string
	}>
}

/** True when `candidate` is `root` or below it. */
function isInside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate)
	return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * The session's directories over a list the caller keeps.
 *
 * The list is shared rather than copied: the session reads it at every turn,
 * and `/add-dir` must be visible to the next one.
 */
export function createSessionDirectories(cwd: string, directories: string[]): SessionDirectories {
	const root = resolve(cwd)
	return {
		list: () => [...directories],
		add: async (path, options) => {
			const absolute = resolve(root, path)
			if (absolute === root)
				return { added: false, path: absolute, reason: 'That is the working directory.' }
			if (directories.includes(absolute))
				return { added: false, path: absolute, reason: 'Already added.' }
			const entry = await stat(absolute).catch(() => null)
			if (!entry?.isDirectory()) return { added: false, path: absolute, reason: 'Not a directory.' }
			if (!isInside(root, absolute)) {
				if (!options?.approve) {
					return {
						added: false,
						path: absolute,
						reason:
							'It is outside the working directory, and adding it needs your approval, which this surface cannot ask for.',
					}
				}
				if (!(await options.approve(absolute))) {
					return { added: false, path: absolute, reason: 'Not approved.' }
				}
			}
			directories.push(absolute)
			return { added: true, path: absolute }
		},
	}
}
