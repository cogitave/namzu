import { lstatSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
	ProjectDocumentSchema,
	type ProjectId,
	SessionPaths,
	hashedSlugForCwd,
	slugForCwd,
} from '@namzu/sdk'

/**
 * The project a checkout root is filed under, found WITHOUT creating one.
 *
 * The same two slugs `ensureProject` tries, in the same order: the plain
 * slug, then the hashed one when the plain slug's `project.json` names a
 * different directory. A status request must never mint a project, so a
 * missing document ends the search.
 */
export async function findProject(
	root: string,
	projectRoot: string,
): Promise<{ readonly slug: string; readonly projectId: ProjectId } | null> {
	for (const slug of [slugForCwd(projectRoot), hashedSlugForCwd(projectRoot)]) {
		const file = new SessionPaths({ home: root, slug }).projectFile()
		let raw: string
		try {
			const entry = lstatSync(file)
			if (!entry.isFile() || entry.isSymbolicLink())
				throw new Error(`${file} must be a regular file, without a symbolic link.`)
			raw = await readFile(file, 'utf8')
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
			throw error
		}
		const document = ProjectDocumentSchema.parse(JSON.parse(raw))
		if (document.cwd === projectRoot) return { slug, projectId: document.projectId as ProjectId }
	}
	return null
}
