/**
 * Trusted-folder store — `~/.namzu/trust.json`.
 *
 * Trust gate: before namzu reads, runs commands in, or edits files in a
 * directory, the user must trust it. Trusted directories
 * are remembered here so the prompt only appears once per folder. A folder
 * counts as trusted if it — or any ancestor — has been trusted, so
 * trusting a repo root covers its subfolders.
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

import { canonicalProjectPath } from '../../permissions/canonical-project.js'
import { namzuHomePath } from '../state/home.js'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const TRUST_FILE_VERSION = 1

function canonicalStoredPath(dir: string): string {
	try {
		return canonicalProjectPath(dir)
	} catch {
		// A remembered checkout may have been removed. Keeping its normalized
		// name readable does not admit a live project; the target below must
		// resolve successfully before it can match.
		return resolve(dir)
	}
}

interface TrustFile {
	readonly version: number
	readonly trusted: string[]
}

export function trustFilePath(home?: string): string {
	return join(namzuHomePath(home), 'trust.json')
}

function readTrustedFile(file: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<TrustFile>
		return Array.isArray(parsed.trusted) ? parsed.trusted.filter((d) => typeof d === 'string') : []
	} catch {
		return []
	}
}
export function readTrustedDirs(home?: string): string[] {
	return readTrustedFile(trustFilePath(home))
}

/** True when `dir` or any ancestor is in the trusted list. */
export function isTrusted(dir: string, home?: string): boolean {
	return trustedByDirectories(dir, readTrustedDirs(home))
}

/** Same trust decision in an already authenticated application root, without ambient home lookup. */
export function isTrustedAtStateRoot(dir: string, stateRoot: string): boolean {
	return trustedByDirectories(dir, readTrustedFile(join(resolve(stateRoot), 'trust.json')))
}
function trustedByDirectories(dir: string, directories: readonly string[]): boolean {
	let target: string
	try {
		target = canonicalProjectPath(dir)
	} catch {
		return false
	}
	const trusted = directories.map(canonicalStoredPath)
	for (const t of trusted) {
		if (target === t || target.startsWith(t.endsWith(sep) ? t : t + sep)) {
			return true
		}
	}
	return false
}

/** Add `dir` to the trusted list (idempotent). */
export function trustDir(dir: string, home?: string): void {
	const target = canonicalProjectPath(dir)
	const current = readTrustedDirs(home)
	if (current.map(canonicalStoredPath).includes(target)) return
	const next: TrustFile = {
		version: TRUST_FILE_VERSION,
		trusted: [...current, target],
	}
	const path = trustFilePath(home)
	writeTrustFile(path, next)
}

/** Written whole under a name of its own, then renamed: a reader never sees half a file. */
function writeTrustFile(path: string, next: TrustFile): void {
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
	try {
		writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE })
		renameSync(temporary, path)
	} catch (error) {
		rmSync(temporary, { force: true })
		throw error
	}
}

export interface UntrustResult {
	/** True when an entry naming exactly this folder was removed. */
	readonly removed: boolean
	/** An ancestor entry that still covers the folder; only that entry's removal untrusts it. */
	readonly stillTrustedBy?: string
}

/**
 * Remove `dir` from the trusted list. Only the entry that names this exact folder goes: an
 * ancestor entry is never touched, and when one still covers the folder it is reported rather
 * than silently honoured. Idempotent.
 */
export function untrustDir(dir: string, home?: string): UntrustResult {
	const target = canonicalProjectPath(dir)
	const current = readTrustedDirs(home)
	const kept = current.filter((entry) => canonicalStoredPath(entry) !== target)
	const removed = kept.length !== current.length
	if (removed) {
		const next: TrustFile = { version: TRUST_FILE_VERSION, trusted: kept }
		const path = trustFilePath(home)
		writeTrustFile(path, next)
	}
	const cover = kept
		.map(canonicalStoredPath)
		.find((entry) => target.startsWith(entry.endsWith(sep) ? entry : entry + sep))
	return { removed, ...(cover ? { stillTrustedBy: cover } : {}) }
}
