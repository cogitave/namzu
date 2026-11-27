import { ArchiveError, type ArchiveFile, type ArchiveLimits, openArchive } from '../archive/zip.js'
import { ExtensionError } from './errors.js'

/**
 * A `.nzx` package is a zip read by the shared safe archive module (`../archive/zip.ts`) under the caps
 * below; a refusal is reported as an {@link ExtensionError}. The safety checks run on the central
 * directory BEFORE any entry is inflated: a package that fails one writes nothing anywhere.
 */

export const MAX_ENTRIES = 500
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024
export const MAX_RATIO = 100

const LIMITS: ArchiveLimits = {
	maxEntries: MAX_ENTRIES,
	maxUnpackedBytes: MAX_UNPACKED_BYTES,
	maxRatio: MAX_RATIO,
	allowExecutable: true,
	subject: 'package',
}

export type PackageFile = ArchiveFile

/** Every file of a package, in memory, after the zip-safety checks. Directory entries are dropped. */
export function openPackage(archive: Buffer): Map<string, PackageFile> {
	try {
		return openArchive(archive, LIMITS)
	} catch (err) {
		if (err instanceof ArchiveError) throw new ExtensionError('bad-package', err.check, err.message)
		throw err
	}
}
