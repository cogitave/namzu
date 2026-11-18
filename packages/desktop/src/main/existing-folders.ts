import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

const MOST_PATHS = 200

/** `~` and `~/x` stand for the home folder, the way the engine's own settings read them. */
function resolved(path: string): string | undefined {
	if (path === '~') return homedir()
	if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
	return isAbsolute(path) ? path : undefined
}

/**
 * Which of the given folders exist, for the list of extra folders that flags a missing one. Only
 * an absolute path (or one that starts with `~`) can be checked: a relative path means a
 * different folder in each project, so it is answered as found and never flagged. The answer is the paths
 * that exist and are folders, and nothing else about them.
 */
export async function existingFolders(paths: unknown): Promise<string[]> {
	if (!Array.isArray(paths) || paths.length > MOST_PATHS)
		throw new Error('Choose the folders to check.')
	const found: string[] = []
	for (const path of paths) {
		if (typeof path !== 'string' || path.length === 0 || path.length > 4096)
			throw new Error('Choose the folders to check.')
		const where = resolved(path)
		if (where === undefined) {
			// A relative folder cannot be told from here; it is not called missing.
			found.push(path)
			continue
		}
		try {
			if ((await stat(where)).isDirectory()) found.push(path)
		} catch {
			// Missing, or not readable: not there for Namzu either.
		}
	}
	return found
}
