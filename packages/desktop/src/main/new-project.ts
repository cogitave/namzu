import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const NEW_PROJECT_NAME = 'New project'
const SUFFIX_LIMIT = 1000

export interface NewProjectDeps {
	/** The person's Documents folder. */
	documents: string
	mkdir?: (path: string, options: { recursive: boolean }) => Promise<unknown>
	/** Runs `git init` in the folder; a rejection (git missing, any failure) is ignored. */
	git?: (cwd: string) => Promise<void>
}

function gitInit(cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile('git', ['init'], { cwd, timeout: 15_000, windowsHide: true }, (error) =>
			error ? reject(error) : resolve(),
		)
	})
}

/**
 * Creates `Documents/Namzu/New project`, or `New project 2`, `New project 3`… when taken, and
 * initializes git there when git is available. The leaf is created without `recursive` so two
 * windows racing for the same name cannot share a folder: the loser gets EEXIST and moves on.
 */
export async function createNewProject(deps: NewProjectDeps): Promise<string> {
	const make = deps.mkdir ?? ((path, options) => mkdir(path, options))
	const parent = join(deps.documents, 'Namzu')
	await make(parent, { recursive: true })
	for (let n = 1; n <= SUFFIX_LIMIT; n++) {
		const path = join(parent, n === 1 ? NEW_PROJECT_NAME : `${NEW_PROJECT_NAME} ${n}`)
		try {
			await make(path, { recursive: false })
		} catch (failure) {
			if ((failure as NodeJS.ErrnoException).code === 'EEXIST') continue
			throw failure
		}
		try {
			await (deps.git ?? gitInit)(path)
		} catch {
			// A project without git is still a project.
		}
		return path
	}
	throw new Error(
		`Every name from "${NEW_PROJECT_NAME}" to "${NEW_PROJECT_NAME} ${SUFFIX_LIMIT}" is taken in ${parent}.`,
	)
}
