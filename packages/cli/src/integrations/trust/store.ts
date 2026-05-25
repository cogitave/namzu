/**
 * Trusted-folder store — `~/.namzu/trust.json`.
 *
 * Claude-Code-style trust gate: before namzu reads, runs commands in, or
 * edits files in a directory, the user must trust it. Trusted directories
 * are remembered here so the prompt only appears once per folder. A folder
 * counts as trusted if it — or any ancestor — has been trusted, so
 * trusting a repo root covers its subfolders.
 */

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

const DIR_MODE = 0o700
const FILE_MODE = 0o600
const TRUST_FILE_VERSION = 1

interface TrustFile {
	readonly version: number
	readonly trusted: string[]
}

export function trustFilePath(home: string = homedir()): string {
	return join(home, '.namzu', 'trust.json')
}

/** Resolve symlinks + normalize so the same dir isn't trusted twice. */
function canonical(dir: string): string {
	try {
		return realpathSync(resolve(dir))
	} catch {
		return resolve(dir)
	}
}

export function readTrustedDirs(home: string = homedir()): string[] {
	try {
		const parsed = JSON.parse(readFileSync(trustFilePath(home), 'utf8')) as Partial<TrustFile>
		return Array.isArray(parsed.trusted) ? parsed.trusted.filter((d) => typeof d === 'string') : []
	} catch {
		return []
	}
}

/** True when `dir` or any ancestor is in the trusted list. */
export function isTrusted(dir: string, home: string = homedir()): boolean {
	const target = canonical(dir)
	const trusted = readTrustedDirs(home).map(canonical)
	for (const t of trusted) {
		if (target === t || target.startsWith(t.endsWith(sep) ? t : t + sep)) {
			return true
		}
	}
	return false
}

/** Add `dir` to the trusted list (idempotent). */
export function trustDir(dir: string, home: string = homedir()): void {
	const target = canonical(dir)
	const current = readTrustedDirs(home)
	if (current.map(canonical).includes(target)) return
	const next: TrustFile = { version: TRUST_FILE_VERSION, trusted: [...current, target] }
	const path = trustFilePath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: FILE_MODE })
}
