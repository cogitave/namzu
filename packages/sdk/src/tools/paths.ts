import { isAbsolute, relative, resolve } from 'node:path'

/**
 * Resolve a caller-supplied path against a root, refusing anything that
 * lands outside it.
 *
 * The containment rule existed, in one private function inside the local
 * sandbox provider, and the filesystem tools never reached it. They called
 * `resolve(workingDirectory, input.path)` bare — so `path: "../../.."`
 * resolved to whatever is above the working directory and the tool read it
 * happily. That holds with no sandbox configured at all, which is the
 * common case, so the escape did not need a misconfiguration to reach: a
 * model that asks for a parent directory gets one.
 *
 * `relative()` rather than a `startsWith` prefix test: a prefix test says
 * `/workspace-backup` is inside `/workspace`, and the whole point is to be
 * exact about the boundary.
 */
export function resolveWithin(root: string, candidate: string | undefined): string {
	if (candidate === undefined || candidate === '') return resolve(root)

	const resolvedRoot = resolve(root)
	const resolved = resolve(resolvedRoot, candidate)
	const rel = relative(resolvedRoot, resolved)

	// An absolute `rel` means the two paths share no root at all (a
	// different drive on Windows); a leading `..` means it climbed out.
	if (rel.startsWith('..') || isAbsolute(rel)) {
		throw new Error(
			`Path escapes the working directory: ${candidate}. Tools may only reach inside ${resolvedRoot}.`,
		)
	}
	return resolved
}

/** True when `candidate` resolves inside `root`. */
export function isWithin(root: string, candidate: string): boolean {
	try {
		resolveWithin(root, candidate)
		return true
	} catch {
		return false
	}
}
