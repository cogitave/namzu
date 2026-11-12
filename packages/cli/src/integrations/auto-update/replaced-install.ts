/**
 * Recognising that the install this process started from was replaced while it ran.
 *
 * The bundle is split into hash-named chunks and a running process loads some of them only
 * when it first needs them. A newer version installed over the same folder removes the old
 * chunk files, so the next first-time load names a file that is gone. That is not a crash
 * of Namzu: the session is saved, and the fix is to start again. This module says so in one
 * plain line instead of a stack trace, and only when it is true: the version on disk must differ
 * from the one running, and the missing file must be one of this install's own.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLI_VERSION } from '../../version.js'

/** The package folder this code runs from (`…/@namzu/cli`), two levels above `dist/chunks`. */
function runningPackageRoot(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
}

/** The version the folder on disk names now, or null when it cannot be read. */
export function versionOnDisk(packageRoot: string = runningPackageRoot()): string | null {
	try {
		const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
			name?: unknown
			version?: unknown
		}
		return parsed.name === '@namzu/cli' && typeof parsed.version === 'string'
			? parsed.version
			: null
	} catch {
		return null
	}
}

export interface ReplacedInstallInput {
	readonly error: unknown
	/** The version this process is running. */
	readonly running?: string
	/** The package folder it runs from. */
	readonly packageRoot?: string
	/** The version the folder on disk names now (tests). */
	readonly onDisk?: string | null
}

/** The file a failed import named, or undefined when the error is not a failed load of a file. */
function missingFile(error: unknown): string | undefined {
	if (typeof error !== 'object' || error === null) return undefined
	const { code, url, path, message } = error as {
		code?: unknown
		url?: unknown
		path?: unknown
		message?: unknown
	}
	if (code === 'ERR_MODULE_NOT_FOUND' && typeof url === 'string') {
		try {
			return fileURLToPath(url)
		} catch {
			return undefined
		}
	}
	if (code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string') {
		const file = /Cannot find module '([^']+)'/.exec(message)?.[1]
		if (file !== undefined) return file
		// A package that is gone names the file that asked for it: "Cannot find package 'x' imported from <file>".
		return /^Cannot find package '[^']+' imported from (.+?)\.?$/m.exec(message)?.[1]
	}
	if (code === 'ENOENT' && typeof path === 'string') return path
	return undefined
}

/**
 * True when `error` is a load of one of this install's own files that failed because the
 * install was replaced by another version while this process ran.
 */
export function installWasReplaced(input: ReplacedInstallInput): boolean {
	const file = missingFile(input.error)
	if (file === undefined) return false
	const root = input.packageRoot ?? runningPackageRoot()
	if (!resolve(file).startsWith(resolve(root) + sep)) return false
	const onDisk = input.onDisk !== undefined ? input.onDisk : versionOnDisk(root)
	return onDisk !== null && onDisk !== (input.running ?? CLI_VERSION)
}

/**
 * The one line to show instead of a stack trace. The conversation is already on disk: the
 * journal is written as the session goes, and the code that failed to load writes nothing.
 */
export function replacedInstallLine(running: string = CLI_VERSION, onDisk?: string | null): string {
	const now = onDisk === undefined ? versionOnDisk() : onDisk
	const what = now
		? `Namzu ${now} was installed while this window was open, so part of Namzu ${running} is no longer on disk and this could not be done.`
		: 'Namzu was updated while this window was open, so part of it is no longer on disk and this could not be done.'
	return `${what} Your conversation is saved; start Namzu again to continue it.`
}
