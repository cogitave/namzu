/**
 * `~/.namzu/providers.json` store.
 *
 * - Reads return `[]` (not error) when the file is missing — first-run UX.
 * - Writes are atomic: temp file + rename. Mode 0600 enforced on every write.
 * - `resolveApiKey(profile, env)` cascades `NAMZU_<NAME>_API_KEY` (per-
 *   profile override) → per-type vendor default (`OPENAI_API_KEY` etc.)
 *   → profile.apiKey on-disk → null. Hermes-style ergonomics.
 * - Uniqueness invariants enforced on write: no duplicate `name`; at most
 *   one profile with `default: true`.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
	PROVIDERS_FILE_VERSION,
	ProfileValidationError,
	type ProviderProfile,
	type ProvidersFile,
	TYPE_ENV_FALLBACK,
	validateProfile,
} from './schema.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700

export class ProvidersStoreError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ProvidersStoreError'
	}
}

export interface StoreLocation {
	readonly path: string
}

export function providersPath(home: string = homedir()): string {
	return join(home, '.namzu', 'providers.json')
}

export function readProfiles(home: string = homedir()): ProviderProfile[] {
	const path = providersPath(home)
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
		throw new ProvidersStoreError(
			`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new ProvidersStoreError(
			`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	if (typeof parsed !== 'object' || parsed === null) {
		throw new ProvidersStoreError(`${path} top-level must be an object`)
	}
	const file = parsed as Partial<ProvidersFile>
	if (file.version !== PROVIDERS_FILE_VERSION) {
		throw new ProvidersStoreError(
			`${path} has unsupported version ${String(file.version)}; expected ${PROVIDERS_FILE_VERSION}. Upgrade @namzu/cli, or back up the file and re-create your profiles with \`namzu providers add\`.`,
		)
	}
	if (!Array.isArray(file.profiles)) {
		throw new ProvidersStoreError(`${path}.profiles must be an array`)
	}
	const validated: ProviderProfile[] = []
	for (const entry of file.profiles) {
		try {
			validated.push(validateProfile(entry))
		} catch (err) {
			if (err instanceof ProfileValidationError) {
				throw new ProvidersStoreError(`${path}: invalid profile — ${err.message}`)
			}
			throw err
		}
	}
	return validated
}

export function writeProfiles(
	profiles: readonly ProviderProfile[],
	home: string = homedir(),
): void {
	assertInvariants(profiles)
	const path = providersPath(home)
	const dir = dirname(path)
	mkdirSync(dir, { recursive: true, mode: DIR_MODE })
	const payload: ProvidersFile = { version: PROVIDERS_FILE_VERSION, profiles: [...profiles] }
	const body = `${JSON.stringify(payload, null, 2)}\n`
	// PID alone is not enough — two concurrent writes in the same process
	// (Promise.all on `providers add` from a script, for example) would
	// collide on the temp file and one mutation could be lost. Append a
	// random suffix so each writer has its own temp path; the final
	// `renameSync` is atomic per-rename so the last successful rename
	// wins (caller's responsibility to serialize semantically distinct
	// mutations — see assertInvariants for the in-memory check).
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
	writeFileSync(tmp, body, { mode: FILE_MODE })
	// Ensure mode even when umask interfered.
	chmodSync(tmp, FILE_MODE)
	renameSync(tmp, path)
}

export function assertInvariants(profiles: readonly ProviderProfile[]): void {
	const seen = new Set<string>()
	let defaults = 0
	for (const p of profiles) {
		if (seen.has(p.name)) {
			throw new ProvidersStoreError(`duplicate profile name: ${p.name}`)
		}
		seen.add(p.name)
		if (p.default === true) defaults += 1
	}
	if (defaults > 1) {
		throw new ProvidersStoreError(`at most one profile may have default: true (got ${defaults})`)
	}
}

/**
 * Resolve the live API key for a profile, honoring overrides:
 *   1. `NAMZU_<UPPERCASE_NAME>_API_KEY` (per-profile override)
 *   2. Per-type vendor default (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
 *   3. `profile.apiKey` (on-disk)
 *   4. `null` (no key — caller decides whether that's fatal)
 */
export function resolveApiKey(
	profile: ProviderProfile,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const namedEnv = env[`NAMZU_${nameToEnv(profile.name)}_API_KEY`]
	if (namedEnv && namedEnv.length > 0) return namedEnv
	const fallbackName = TYPE_ENV_FALLBACK[profile.type]
	if (fallbackName) {
		const v = env[fallbackName]
		if (v && v.length > 0) return v
	}
	const onDisk = (profile as { apiKey?: string }).apiKey
	if (onDisk && onDisk.length > 0) return onDisk
	return null
}

export function findDefault(profiles: readonly ProviderProfile[]): ProviderProfile | null {
	return profiles.find((p) => p.default === true) ?? null
}

function nameToEnv(name: string): string {
	return name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
}
