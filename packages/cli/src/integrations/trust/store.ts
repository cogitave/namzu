/**
 * Trusted-folder store — `~/.namzu/trust.json`.
 *
 * Trust gate: before namzu reads, runs commands in, or edits files in a
 * directory, the user must trust it. Trusted directories
 * are remembered here so the prompt only appears once per folder. A folder
 * counts as trusted if it — or any ancestor — has been trusted, so
 * trusting a repo root covers its subfolders.
 *
 * The terminal, the Desktop engine and Desktop itself all change this file, so
 * every change is made under its lock and re-reads it first (see
 * `../state/state-file.ts`). A file that exists but is not a trust list reads
 * as trusting nothing, and is never replaced: a change to it is refused, with
 * its bytes kept in `backups/`.
 */

import { readFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

import { canonicalProjectPath } from '../../permissions/canonical-project.js'
import { namzuHomePath } from '../state/home.js'
import {
	readFailureReason,
	saveStateFile,
	unreadableStateFile,
	withStateFileLock,
} from '../state/state-file.js'

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

/**
 * What is on disk. `entries` is the list as written, entries this version
 * does not understand included, and `rest` the other top-level keys: a change
 * writes both back, so nothing a newer or older writer put there is lost.
 */
type TrustRead =
	| { readonly state: 'missing' }
	| {
			readonly state: 'ok'
			readonly entries: readonly unknown[]
			readonly rest: Readonly<Record<string, unknown>>
	  }
	| { readonly state: 'unreadable'; readonly reason: string }

export function trustFilePath(home?: string): string {
	return join(namzuHomePath(home), 'trust.json')
}

function readTrustState(file: string): TrustRead {
	let text: string
	try {
		text = readFileSync(file, 'utf8')
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' }
		return { state: 'unreadable', reason: readFailureReason(error) }
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(text)
	} catch (error) {
		return { state: 'unreadable', reason: readFailureReason(error) }
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
		return { state: 'unreadable', reason: 'not a trust list' }
	const { trusted, ...rest } = parsed as Record<string, unknown>
	const version = rest.version
	if (version !== undefined && (typeof version !== 'number' || version > TRUST_FILE_VERSION))
		return { state: 'unreadable', reason: `version ${String(version)} is newer than this Namzu` }
	if (trusted !== undefined && !Array.isArray(trusted))
		return { state: 'unreadable', reason: 'its "trusted" entry is not a list' }
	return { state: 'ok', entries: trusted ?? [], rest }
}

function trustedStrings(read: TrustRead): string[] {
	return read.state === 'ok'
		? read.entries.filter((entry): entry is string => typeof entry === 'string')
		: []
}

function readTrustedFile(file: string): string[] {
	return trustedStrings(readTrustState(file))
}

export function readTrustedDirs(home?: string): string[] {
	return readTrustedFile(trustFilePath(home))
}

/** Why the trusted folders list cannot be used, when it exists but does not read. */
export interface TrustListProblem {
	readonly file: string
	readonly reason: string
}

export function trustListProblem(home?: string): TrustListProblem | undefined {
	return problemAt(trustFilePath(home))
}

/** The same question for the list in an already resolved Namzu home. */
export function trustListProblemAtStateRoot(stateRoot: string): TrustListProblem | undefined {
	return problemAt(join(resolve(stateRoot), 'trust.json'))
}

function problemAt(file: string): TrustListProblem | undefined {
	const read = readTrustState(file)
	return read.state === 'unreadable' ? { file, reason: read.reason } : undefined
}

/**
 * Refuses, with the file's bytes kept in `backups/`, when the trusted folders
 * list exists but cannot be read; a later change would otherwise have to
 * replace it. For a caller that must not start work it cannot record.
 */
export function assertTrustListWritable(home?: string): void {
	const file = trustFilePath(home)
	const read = readTrustState(file)
	if (read.state === 'unreadable') throw unreadableStateFile(file, read.reason, namzuHomePath(home))
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
	const path = trustFilePath(home)
	withStateFileLock(path, () => {
		const read = readTrustState(path)
		if (read.state === 'unreadable')
			throw unreadableStateFile(path, read.reason, namzuHomePath(home))
		if (trustedStrings(read).map(canonicalStoredPath).includes(target)) return
		const entries = read.state === 'ok' ? read.entries : []
		writeTrustFile(path, read, [...entries, target], home)
	})
}

function writeTrustFile(
	path: string,
	read: TrustRead,
	trusted: readonly unknown[],
	home: string | undefined,
): void {
	const rest = read.state === 'ok' ? read.rest : {}
	const next = { ...rest, version: TRUST_FILE_VERSION, trusted }
	saveStateFile(path, `${JSON.stringify(next, null, 2)}\n`, { home: namzuHomePath(home) })
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
 * than silently honoured. Idempotent. A list that cannot be read is refused, not answered as
 * "not on the list".
 */
export function untrustDir(dir: string, home?: string): UntrustResult {
	const target = canonicalProjectPath(dir)
	const path = trustFilePath(home)
	return withStateFileLock(path, () => {
		const read = readTrustState(path)
		if (read.state === 'unreadable')
			throw unreadableStateFile(path, read.reason, namzuHomePath(home))
		const entries = read.state === 'ok' ? read.entries : []
		const kept = entries.filter(
			(entry) => typeof entry !== 'string' || canonicalStoredPath(entry) !== target,
		)
		const removed = kept.length !== entries.length
		if (removed) writeTrustFile(path, read, kept, home)
		const cover = kept
			.filter((entry): entry is string => typeof entry === 'string')
			.map(canonicalStoredPath)
			.find((entry) => target.startsWith(entry.endsWith(sep) ? entry : entry + sep))
		return { removed, ...(cover ? { stillTrustedBy: cover } : {}) }
	})
}
