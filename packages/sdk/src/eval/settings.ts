import { createHash } from 'node:crypto'
import { EvalUsageError } from './bootstrap.js'

/**
 * The settings an eval run ran under, as a named, canonical, hashed record.
 *
 * Two reports of one suite say little about a harness setting unless each says
 * exactly which settings it ran under. The snapshot is that statement: a name a
 * person chose (or `default`), a digest of the values, and the values. The
 * digest is taken over the values alone, in a canonical form, so it is the same
 * whatever order the keys were written in and whatever the snapshot is called.
 *
 * Secrets never enter one. {@link buildSettingsSnapshot} refuses a value that
 * names a credential or looks like one, so a report written from a snapshot
 * cannot carry a key even if a caller passed it by mistake.
 */
export interface SettingsSnapshot {
	/** What the person called it; the file's name when it came from a file. */
	readonly name: string
	/** SHA-256 of the canonical JSON of {@link values}, in hex. */
	readonly digest: string
	/** How the digest was made, so a later version can change it without a silent mismatch. */
	readonly algorithm: typeof SETTINGS_DIGEST_ALGORITHM
	/** The settings that differ from the defaults: whatever was stated. Empty for `default`. */
	readonly values: Readonly<Record<string, unknown>>
}

export const SETTINGS_DIGEST_ALGORITHM = 'sha256-canonical-json-1'

/** The name of the snapshot of a run that was given no settings. */
export const DEFAULT_SETTINGS_NAME = 'default'

/** What a suite that read the settings says about it, written into its report. */
export interface ReportSettings extends SettingsSnapshot {
	/**
	 * Whether the suite asked for the settings while it ran. A suite that never
	 * does cannot have been shaped by them, so a difference between two snapshots
	 * says nothing about its numbers.
	 */
	readonly read: boolean
	/**
	 * The dotted paths the suite asked for, or `*` when it asked for the whole
	 * object. Absent from a report that predates it, which is read as every key.
	 */
	readonly readKeys?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Canonical JSON: keys sorted at every level, no whitespace, array order kept.
 * A value JSON cannot carry (`undefined` inside an array, a non-finite number,
 * a function) is refused, because a digest over a value that cannot be written
 * back would name something nobody can reproduce. An `undefined` object field
 * is the same as an absent one and is dropped.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return JSON.stringify(value)
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw new EvalUsageError(`a setting must be a finite number; received ${String(value)}`)
		}
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value
			.map((item) => {
				if (item === undefined) throw new EvalUsageError('a setting list cannot hold undefined')
				return canonicalJson(item)
			})
			.join(',')}]`
	}
	if (isRecord(value)) {
		const parts: string[] = []
		for (const key of Object.keys(value).sort()) {
			const item = value[key]
			if (item === undefined) continue
			parts.push(`${JSON.stringify(key)}:${canonicalJson(item)}`)
		}
		return `{${parts.join(',')}}`
	}
	throw new EvalUsageError(`a setting must be plain JSON; received ${typeof value}`)
}

/** Names that hold a credential. `maxResponseTokens` and `tokenBudget` are not among them. */
const SECRET_KEY =
	/^(?:token|secret|password|passwd|credentials?|authorization|cookie|bearer)$|api[-_]?key|private[-_]?key|secret|passw(?:or)?d|(?:access|auth|refresh|bearer|session|id)[-_]?token|client[-_]?secret/i

/** Shapes of the keys and tokens providers hand out. */
const SECRET_VALUE = [
	// A password written into a URL: scheme://user:password@host
	/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/,
	/\bsk-[A-Za-z0-9_-]{16,}/,
	/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/,
	/\bAKIA[0-9A-Z]{16}\b/,
	/\bAIza[0-9A-Za-z_-]{30,}/,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

/**
 * The path of the first thing in `values` that is, or names, a credential, or
 * undefined when there is none. The path never includes the secret itself.
 */
export function findSecretIn(values: unknown, path = ''): string | undefined {
	if (typeof values === 'string') {
		return SECRET_VALUE.some((pattern) => pattern.test(values)) ? path || '(value)' : undefined
	}
	if (Array.isArray(values)) {
		for (const [index, item] of values.entries()) {
			const hit = findSecretIn(item, `${path}[${index}]`)
			if (hit !== undefined) return hit
		}
		return undefined
	}
	if (isRecord(values)) {
		for (const key of Object.keys(values).sort()) {
			const here = path === '' ? key : `${path}.${key}`
			// A setting that names the environment variable holding a credential
			// (`apiKeyEnv`) holds a name, not a secret, but is still refused: the
			// snapshot has no business carrying where a credential lives.
			if (SECRET_KEY.test(key)) return here
			const hit = findSecretIn(values[key], here)
			if (hit !== undefined) return hit
		}
	}
	return undefined
}

/** A snapshot name is plain: it is printed in a comparison and used as a file label. */
export function validateSettingsName(name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
		throw new EvalUsageError(
			`a settings name is 1 to 64 letters, digits, dots, dashes or underscores, starting with a letter or digit; received ${JSON.stringify(name)}`,
		)
	}
	return name
}

/**
 * Build a snapshot. Throws an {@link EvalUsageError} naming the path of a
 * secret, a value JSON cannot carry, or a name that is not plain. A snapshot
 * called `default` must have no values: `default` is the name of "no settings
 * stated", and a snapshot with values under it would say the opposite.
 */
export function buildSettingsSnapshot(
	name: string,
	values: Readonly<Record<string, unknown>> = {},
): SettingsSnapshot {
	validateSettingsName(name)
	if (!isRecord(values)) throw new EvalUsageError('settings must be an object of settings')
	const secret = findSecretIn(values)
	if (secret !== undefined) {
		throw new EvalUsageError(
			`settings "${secret}" is, or names, a credential. A credential never goes into an eval settings snapshot, because the snapshot is written into the report.`,
		)
	}
	const canonical = canonicalJson(values)
	if (name === DEFAULT_SETTINGS_NAME && canonical !== '{}') {
		throw new EvalUsageError(
			`the name "${DEFAULT_SETTINGS_NAME}" is for a run with no settings stated; give these settings another name`,
		)
	}
	return {
		name,
		digest: createHash('sha256').update(canonical).digest('hex'),
		algorithm: SETTINGS_DIGEST_ALGORITHM,
		// A copy through the canonical form, so what is stored is what was hashed.
		values: JSON.parse(canonical) as Record<string, unknown>,
	}
}

/** The snapshot of a run given no settings. */
export function defaultSettingsSnapshot(): SettingsSnapshot {
	return buildSettingsSnapshot(DEFAULT_SETTINGS_NAME, {})
}

export interface SettingDifference {
	/** Dotted path of the setting; a list is one value. */
	readonly key: string
	/** Absent on the side that does not state it. */
	readonly a?: unknown
	readonly b?: unknown
}

function leaves(value: unknown, path: string, into: Map<string, unknown>): void {
	if (isRecord(value) && Object.keys(value).length > 0) {
		for (const key of Object.keys(value))
			leaves(value[key], path === '' ? key : `${path}.${key}`, into)
		return
	}
	into.set(path, value)
}

/** What differs between two snapshots' values, key by key, sorted by key. */
export function diffSettings(
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
): SettingDifference[] {
	const left = new Map<string, unknown>()
	const right = new Map<string, unknown>()
	leaves(a, '', left)
	leaves(b, '', right)
	left.delete('')
	right.delete('')
	const keys = [...new Set([...left.keys(), ...right.keys()])].sort()
	const out: SettingDifference[] = []
	for (const key of keys) {
		const inA = left.has(key)
		const inB = right.has(key)
		if (inA && inB && canonicalJson(left.get(key)) === canonicalJson(right.get(key))) continue
		out.push({
			key,
			...(inA ? { a: left.get(key) } : {}),
			...(inB ? { b: right.get(key) } : {}),
		})
	}
	return out
}
