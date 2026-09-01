/**
 * Trusted-folder store — `~/.namzu/trust.json`.
 *
 * Trust gate: before namzu reads, runs commands in, or edits files in a
 * directory, the user must trust it. Trusted directories
 * are remembered here so the prompt only appears once per folder. A folder
 * counts as trusted if it — or any ancestor — has been trusted, so
 * trusting a repo root covers its subfolders.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

export function readTrustedDirs(home?: string): string[] {
	try {
		const parsed = JSON.parse(readFileSync(trustFilePath(home), 'utf8')) as Partial<TrustFile>
		return Array.isArray(parsed.trusted) ? parsed.trusted.filter((d) => typeof d === 'string') : []
	} catch {
		return []
	}
}

/** True when `dir` or any ancestor is in the trusted list. */
export function isTrusted(dir: string, home?: string): boolean {
	let target: string
	try {
		target = canonicalProjectPath(dir)
	} catch {
		return false
	}
	const trusted = readTrustedDirs(home).map(canonicalStoredPath)
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
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, {
		mode: FILE_MODE,
	})
}
