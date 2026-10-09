import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

/**
 * The folder to reveal for a Pal. The renderer names a Pal, never a path: main takes the workspace
 * from its own record of that Pal and only reveals it when it is an existing absolute directory.
 */
export async function palFolderToReveal(workspace: unknown): Promise<string> {
	if (
		typeof workspace !== 'string' ||
		!workspace ||
		workspace.includes('\0') ||
		!isAbsolute(workspace)
	)
		throw new Error('This Pal has no folder to open.')
	let resolved: string
	try {
		resolved = await realpath(workspace)
		if (!(await stat(resolved)).isDirectory()) throw new Error('not a directory')
	} catch {
		throw new Error('This Pal’s folder does not exist.')
	}
	return resolved
}
