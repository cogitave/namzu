import { sep } from 'node:path'

import { TempDirectoryError } from '@namzu/sdk'

/**
 * The one line to print when Namzu cannot start because a folder it needs
 * cannot be created on a full disk (or one over its quota), or because its
 * scratch folder cannot be used at all. `undefined` for every other error:
 * those keep the crash report.
 *
 * Only a failed `mkdir` counts as a start-up failure here. The same code from a
 * write in the middle of a session is reported by the session itself, and
 * must not be claimed as "could not create".
 */
export function plainStartupFailure(
	error: unknown,
	namzuHome: () => string | undefined,
): string | undefined {
	if (error instanceof TempDirectoryError) return error.message
	const { code, syscall, path } = (error ?? {}) as {
		code?: unknown
		syscall?: unknown
		path?: unknown
	}
	if ((code !== 'ENOSPC' && code !== 'EDQUOT') || syscall !== 'mkdir' || typeof path !== 'string') {
		return undefined
	}
	const reason = code === 'ENOSPC' ? 'The disk is full' : 'Your disk quota is used up'
	const home = namzuHome()
	const variable =
		home !== undefined && (path === home || path.startsWith(home + sep))
			? 'NAMZU_HOME'
			: 'NAMZU_TMPDIR'
	return `${reason}, so Namzu could not create ${path}. Free some space and start again, or set ${variable} to a folder on another disk.`
}
