import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath } from 'node:fs/promises'
import { basename, extname, join, relative, sep } from 'node:path'

import { resolveWithinReal } from '../tools/paths.js'

import type { DirectoryDiagnostic, DirectorySlot } from './types.js'

/** Extensions Node can import directly, given its own type stripping. */
const CODE_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'])

export interface ScannedFile {
	readonly path: string
	readonly relativePath: string
	readonly id: string
}

export interface ScanResult {
	readonly files: readonly ScannedFile[]
	readonly diagnostics: readonly DirectoryDiagnostic[]
}

/**
 * List the code files directly inside one slot directory.
 *
 * **Symlinks are refused, not followed.** A directory handed to this loader is
 * caller-supplied, and a link inside it pointing anywhere else is the
 * link-following weakness (CWE-59) with the loader as the vehicle: the file
 * that gets imported is not the file that was listed. The estate already
 * decided this for its filesystem tools; the same rule applies to a directory
 * whose author may not be the host.
 *
 * That is stricter than the SDK's own `discoverSkills`, and deliberately so —
 * that function walks a host's own trusted tree, where following a link is a
 * convenience rather than a hole. Reusing it here would have inherited a
 * threat model chosen for a different caller.
 *
 * Only the top level is read. A nested directory is reported so an author
 * learns their file was not picked up, except when its name starts with `.`
 * or `_`, which is the conventional way to say "not for you" and is honoured
 * silently.
 */
export async function scanSlot(
	root: string,
	slot: DirectorySlot,
	dirName: string,
): Promise<ScanResult> {
	const dir = join(root, dirName)
	const files: ScannedFile[] = []
	const diagnostics: DirectoryDiagnostic[] = []

	let entries: Dirent[]
	try {
		entries = await readdir(dir, { withFileTypes: true })
	} catch {
		// An absent optional directory is not news.
		return { files, diagnostics }
	}

	for (const entry of entries) {
		const name = entry.name
		if (name.startsWith('.') || name.startsWith('_')) continue

		const candidate = join(dir, name)

		// `readdir(withFileTypes)` reports the link itself, so this catches a
		// symlink before anything resolves it.
		let stats: Awaited<ReturnType<typeof lstat>>
		try {
			stats = await lstat(candidate)
		} catch {
			continue
		}

		if (stats.isSymbolicLink()) {
			diagnostics.push({
				code: 'symlink_refused',
				severity: 'warning',
				message: `${dirName}/${name} is a symbolic link and was not loaded. The file that would be imported is not the file listed here, so links are refused rather than followed.`,
				path: candidate,
			})
			continue
		}

		// Two slots hold DIRECTORIES rather than files: a skill is a folder
		// with a SKILL.md, and a delegate is a whole project directory.
		const directorySlot = slot === 'skills' || slot === 'agents'

		if (stats.isDirectory()) {
			if (directorySlot) {
				files.push({
					path: candidate,
					relativePath: `${dirName}/${name}`,
					id: name,
				})
				continue
			}
			diagnostics.push({
				code: 'unscanned_directory',
				severity: 'warning',
				message: `${dirName}/${name}/ is a directory and was not scanned. Only files directly inside ${dirName}/ are loaded; prefix a directory with "." or "_" to declare it private and silence this.`,
				path: candidate,
			})
			continue
		}

		if (!stats.isFile()) continue
		// A loose file in a directory slot is not an error worth a diagnostic —
		// a README beside the skill folders is normal.
		if (directorySlot) continue

		if (!CODE_EXTENSIONS.has(extname(name))) {
			diagnostics.push({
				code: 'unscanned_directory',
				severity: 'warning',
				message: `${dirName}/${name} is not a module this loader can import (expected one of ${[...CODE_EXTENSIONS].join(', ')}).`,
				path: candidate,
			})
			continue
		}

		// Containment even though the path was built from a directory listing:
		// the check costs nothing and it is the one place a future change to
		// how `dir` is derived would otherwise escape unnoticed.
		let contained: string
		try {
			contained = await resolveWithinReal(root, relative(root, candidate))
		} catch {
			diagnostics.push({
				code: 'path_escapes_root',
				severity: 'warning',
				message: `${dirName}/${name} resolves outside the project root and was not loaded.`,
				path: candidate,
			})
			continue
		}

		files.push({
			path: contained,
			relativePath: `${dirName}/${name}`,
			id: basename(name, extname(name)),
		})
	}

	files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))
	return { files, diagnostics }
}

/** Canonical absolute root, or undefined when the directory does not exist. */
export async function canonicalRoot(dir: string): Promise<string | undefined> {
	try {
		const resolved = await realpath(dir)
		const stats = await lstat(resolved)
		return stats.isDirectory() ? resolved : undefined
	} catch {
		return undefined
	}
}

/** Posix-normalised, for a `relativePath` that reads the same on every platform. */
export function toPosix(value: string): string {
	return value.split(sep).join('/')
}
