/**
 * Which folders a job may run in.
 *
 * Refused: the file system root, the operator's home directory itself, a
 * folder that contains `NAMZU_HOME` (a run there could rewrite its own job,
 * its history and the credentials beside them), and anything inside
 * `NAMZU_HOME`. The folder is canonicalised once, here; every later check
 * compares against that canonical path.
 */

import { lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path'

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

const SCRATCH_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A stable, private cwd beside NAMZU_HOME. Computing this path never creates it. */
export function plannedScratchFolder(namzuHome: string, jobId: string): string {
	if (!SCRATCH_JOB_ID.test(jobId)) throw new Error(`invalid scheduled job id: ${jobId}`)
	const home = resolve(namzuHome)
	if (home === parse(home).root) throw new Error('NAMZU_HOME cannot be the file system root')
	// Resolve the parent now, so an ordinary symlink in the path to home does
	// not make the stored path differ from its real path at confirmation.
	const parent = realpathSync(dirname(home))
	return join(parent, `${basename(home)}-schedule-workspaces`, jobId)
}

/** The scratch root and leaf must both be real, user-owned 0700 directories. */
export function checkScratchFolder(namzuHome: string, jobId: string): FolderCheck {
	let path: string
	try {
		path = plannedScratchFolder(namzuHome, jobId)
	} catch (error) {
		return {
			ok: false,
			reason: `scratch folder cannot be located: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	for (const dir of [dirname(path), path]) {
		try {
			const st = lstatSync(dir)
			if (!st.isDirectory() || st.isSymbolicLink())
				return { ok: false, reason: `scratch folder path ${dir} is not a real directory` }
			if ((st.mode & 0o777) !== 0o700)
				return { ok: false, reason: `scratch folder path ${dir} must have mode 0700` }
			if (process.getuid && st.uid !== process.getuid())
				return { ok: false, reason: `scratch folder path ${dir} has a different owner` }
			if (realpathSync(dir) !== dir)
				return { ok: false, reason: `scratch folder path ${dir} resolves elsewhere` }
		} catch (error) {
			return {
				ok: false,
				reason: `scratch folder path ${dir} cannot be verified: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
	}
	const checked = checkJobFolder(path, { namzuHome })
	if (!checked.ok) return checked
	if (checked.canonical !== path)
		return { ok: false, reason: `scratch folder ${path} resolves elsewhere` }
	return checked
}

/** Only call after a human confirms. Existing folders are checked, never repaired. */
export function ensureScratchFolder(namzuHome: string, jobId: string): FolderCheck {
	let path: string
	try {
		path = plannedScratchFolder(namzuHome, jobId)
	} catch (error) {
		return {
			ok: false,
			reason: `scratch folder cannot be located: ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	try {
		mkdirSync(dirname(path), { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
			return {
				ok: false,
				reason: `scratch folder cannot be created: ${error instanceof Error ? error.message : String(error)}`,
			}
	}
	// A pre-existing root with wide permissions or a symlink is a hard stop.
	const root = dirname(path)
	try {
		const st = lstatSync(root)
		if (
			!st.isDirectory() ||
			st.isSymbolicLink() ||
			(st.mode & 0o777) !== 0o700 ||
			(process.getuid && st.uid !== process.getuid()) ||
			realpathSync(root) !== root
		)
			return {
				ok: false,
				reason: `scratch folder root ${root} is not a user-owned real directory with mode 0700`,
			}
		mkdirSync(path, { mode: 0o700 })
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
			return {
				ok: false,
				reason: `scratch folder cannot be created: ${error instanceof Error ? error.message : String(error)}`,
			}
	}
	return checkScratchFolder(namzuHome, jobId)
}

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
