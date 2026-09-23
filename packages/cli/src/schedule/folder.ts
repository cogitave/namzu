/**
 * Which folders a job may run in.
 *
 * Refused: the file system root, the operator's home directory itself, a
 * folder that contains `NAMZU_HOME` (a run there could rewrite its own job,
 * its history and the credentials beside them), and anything inside
 * `NAMZU_HOME`. The folder is canonicalised once, here; every later check
 * compares against that canonical path.
 */

import { readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { parse, relative, resolve, sep } from 'node:path'

function isWithinOrSame(parent: string, child: string): boolean {
	const rel = relative(parent, child)
	return (
		rel === '' ||
		(!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..' && !/^[A-Za-z]:/.test(rel))
	)
}

function canonical(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

export type FolderCheck =
	| { readonly ok: true; readonly canonical: string }
	| { readonly ok: false; readonly reason: string }

export function checkJobFolder(
	folder: string,
	options: { readonly namzuHome: string; readonly osHome?: string },
): FolderCheck {
	let real: string
	try {
		real = realpathSync(resolve(folder))
	} catch {
		return { ok: false, reason: `the folder ${folder} does not exist` }
	}
	try {
		if (!statSync(real).isDirectory()) return { ok: false, reason: `${real} is not a directory` }
	} catch {
		return { ok: false, reason: `${real} cannot be read` }
	}
	const namzuHome = canonical(options.namzuHome)
	const osHome = canonical(options.osHome ?? homedir())
	if (real === parse(real).root)
		return { ok: false, reason: 'a job cannot run in the file system root' }
	if (real === osHome) {
		return {
			ok: false,
			reason: `a job cannot run in your home directory itself (${real}); pick the project folder`,
		}
	}
	if (isWithinOrSame(real, namzuHome)) {
		return {
			ok: false,
			reason: `${real} contains NAMZU_HOME (${namzuHome}); a run there could rewrite its own job`,
		}
	}
	if (isWithinOrSame(namzuHome, real)) {
		return { ok: false, reason: `${real} is inside NAMZU_HOME (${namzuHome})` }
	}
	return { ok: true, canonical: real }
}

/**
 * Whether this process can list the folder. On macOS a LaunchAgent reading
 * `~/Documents`, `~/Desktop` or `~/Downloads` meets a privacy prompt nobody
 * sees, and the read fails; saying so beats a run that finds nothing.
 */
export function folderReadable(folder: string): { ok: true } | { ok: false; reason: string } {
	try {
		readdirSync(folder)
		return { ok: true }
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		const tcc =
			process.platform === 'darwin' && /\/(Documents|Desktop|Downloads)(\/|$)/.test(folder)
				? ' — macOS privacy protection may be blocking the scheduler; grant it Files and Folders access, or move the project out of Documents, Desktop or Downloads'
				: ''
		return { ok: false, reason: `${folder} cannot be listed (${code ?? 'error'})${tcc}` }
	}
}

/** macOS folders a LaunchAgent cannot read without a privacy grant. */
export function isPrivacyProtectedFolder(folder: string, osHome = homedir()): boolean {
	return ['Documents', 'Desktop', 'Downloads'].some((name) =>
		isWithinOrSame(resolve(osHome, name), folder),
	)
}
