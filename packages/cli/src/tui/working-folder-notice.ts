import { parse, resolve } from 'node:path'

/**
 * The one quiet line shown at the start of a session whose working folder is
 * the home folder or the filesystem root, where everything the session makes
 * lands straight in a top-level folder. Null anywhere else.
 */
export const WORKING_FOLDER_NOTICE =
	'Working in your home folder: files go straight into it. Open a project folder to keep work in one place.'

export const ROOT_FOLDER_NOTICE =
	'Working at the top of the filesystem: files go straight into it. Open a project folder to keep work in one place.'

export function workingFolderNotice(cwd: string, home: string | undefined): string | null {
	const here = resolve(cwd)
	if (here === parse(here).root) return ROOT_FOLDER_NOTICE
	if (home && here === resolve(home)) return WORKING_FOLDER_NOTICE
	return null
}
