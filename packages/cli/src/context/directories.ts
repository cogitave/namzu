import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * The session's added directories: the ones `/add-dir` extends and every turn
 * reads fresh — the query, the sandbox binds and the environment prompt.
 */
export interface SessionDirectories {
	list(): readonly string[]
	/**
	 * Add one for the rest of the session, stored under its canonical path.
	 *
	 * A directory inside the working directory is not added: the tools
	 * already reach it, and a root inside the tree the agent writes to is one
	 * a later command could swap for a link.
	 *
	 * A directory outside the working directory — decided after links are
	 * followed — is added only when `approve` answers yes for the canonical
	 * path it leads to. Adding one lets every file tool reach
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
			// Decided on canonical paths, because the file tools resolve an
			// added directory through its links (`resolveWithinReal`): a
			// lexical test would call `./link -> /elsewhere` inside, add it
			// unasked, and every tool would then reach /elsewhere. The
			// question names where it really leads.
			const real = await realpath(absolute)
			const realRoot = await realpath(root).catch(() => root)
			if (real === realRoot)
				return { added: false, path: absolute, reason: 'That is the working directory.' }
			// Inside the working directory there is nothing to add: the tools
			// already reach it. Adding it anyway would make a root the agent can
			// rewrite — `rm -r sub && ln -s /elsewhere sub` from one command, a
			// sandboxed one included — and the file tools canonicalize a root at
			// every call, so the added root would then lead elsewhere unasked.
			if (isInside(realRoot, real)) {
				return {
					added: false,
					path: real,
					reason: 'It is inside the working directory, which the tools already reach.',
				}
			}
			if (directories.includes(real)) return { added: false, path: real, reason: 'Already added.' }
			if (!options?.approve) {
				return {
					added: false,
					path: absolute,
					reason:
						'It is outside the working directory, and adding it needs your approval, which this surface cannot ask for.',
				}
			}
			if (!(await options.approve(real))) {
				return { added: false, path: absolute, reason: 'Not approved.' }
			}
			// The canonical path, the one that was approved — never the spelling.
			// The file tools canonicalize a root at every call, so a stored
			// `./link` would follow wherever the link points later, not where it
			// pointed when the question was asked.
			directories.push(real)
			return { added: true, path: real }
		},
	}
}
