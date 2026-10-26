import { lstat, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path'

function inside(root: string, path: string): boolean {
	const rel = relative(root, path)
	return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * The real path of a retained tool-output file the model may read, or
 * `undefined` when `candidate` is not one.
 *
 * Only this session's own retained directory counts. The file must be an
 * absolute path to a regular `.txt` file that is not a symbolic link, has no
 * other hard link, and whose real location is inside the directory's real
 * location (so a link anywhere along the path, or `..`, takes it out). Nothing
 * is created, and nothing but a read is offered.
 */
export async function resolveRetainedOutput(
	directory: string | undefined,
	candidate: string | undefined,
): Promise<string | undefined> {
	if (!directory || !candidate || !isAbsolute(candidate) || candidate.includes('\0'))
		return undefined
	try {
		const base = await realpath(directory)
		const lexical = resolve(candidate)
		if (extname(lexical).toLowerCase() !== '.txt') return undefined
		if (!inside(resolve(directory), lexical) && !inside(base, lexical)) return undefined
		const stat = await lstat(lexical)
		if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return undefined
		const real = await realpath(lexical)
		if (!inside(base, real) || dirname(real) === real) return undefined
		return real
	} catch {
		return undefined
	}
}
