import type { DoctorCheck, DoctorCheckResult } from '@namzu/sdk'

import { bothFilesNotes, presentFolderFiles } from '../../config/project-files.js'
import { isTrusted } from '../../integrations/trust/store.js'

/**
 * Which of the folder's settings files are there, and whether two of one kind
 * are read at once.
 *
 * A `pass` naming the files; a `warn` when both shared files
 * (`namzu.config.json` and `.namzu/settings.json`) or both local files (the
 * earlier `namzu.config.local.json` and `.namzu/settings.local.json`, holding
 * different settings) are there. Both are read either way; the row says so,
 * so a person can keep one.
 */
export function describeFolderFiles(cwd: string, trusted = true): DoctorCheckResult {
	const present = [...presentFolderFiles(cwd, 'project'), ...presentFolderFiles(cwd, 'local')]
	if (present.length === 0)
		return { status: 'pass', message: 'This folder has no Namzu settings files.' }
	const names = present.map((file) => file.name).join(', ')
	// An untrusted folder's files are not read, here either.
	if (!trusted)
		return {
			status: 'pass',
			message: `This folder is not trusted, so its settings files are not read: ${names}.`,
		}
	const named = `Settings files read in this folder: ${names}.`
	const notes = bothFilesNotes(cwd)
	if (notes.length === 0) return { status: 'pass', message: named }
	return {
		status: 'warn',
		message: `${named} ${notes.join(' ')}`,
		remediation: 'Keep one file of each kind. Both stay in force until you do.',
	}
}

export function folderFilesCheck(): DoctorCheck {
	return {
		id: 'runtime.folder-settings-files',
		category: 'runtime',
		run: async (ctx): Promise<DoctorCheckResult> =>
			describeFolderFiles(ctx.cwd, isTrusted(ctx.cwd)),
	}
}
