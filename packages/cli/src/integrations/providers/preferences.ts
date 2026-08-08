/**
 * `~/.namzu/preferences.json` — the operator's provider chain.
 *
 * Schema (current = v3):
 *   {
 *     "version": 3,
 *     "providers": [                      // ordered; index 0 is the primary
 *       { "id": "anthropic", "model": "claude-opus-4-7" },
 *       { "id": "openai" }                // model omitted → the registry default
 *     ],
 *     "subagents": { "active": [...] }    // instances reserved for subagent dispatch
 *   }
 *
 * The chain is an ORDER the operator declares, replacing the single provider v2
 * held. It is deliberately a plain readable array in a file the operator owns:
 * the order has to be legible and editable without launching the TUI, which a
 * value only reachable through an interactive picker is not.
 *
 * `providers[0]` serves; the rest are fallen over to, in order, when it cannot.
 * The tail is still validated and reported ahead of any failure (see
 * `readPreferences` and the `providers.chain` doctor check), because a fallback
 * is invisible by construction — nothing exercises it until the primary is
 * already down, which is the worst moment to discover the key was never set.
 *
 * ## Versions
 *
 * v1 stored a peer instance as the default — a different primitive (subagent
 * dispatch, not primary chat). It is still REFUSED rather than migrated, because
 * mapping between the two semantics would surprise more than help.
 *
 * v2 stored a single `provider` + optional `model`. It IS migrated, on read, in
 * memory: one provider is a one-element chain, which is unambiguous, and the
 * distinction from v1 is exactly that. Migration does not rewrite the file — a
 * reader with a write side effect would rewrite `$HOME` on a `--help`. The next
 * `writePreferences` lands v3.
 *
 * Note the consequence: a v3 file read by an older namzu reports `needs-repick`
 * rather than silently losing the tail, which is the safe direction.
 */

import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { PROVIDER_REGISTRY, type ProviderId } from './registry.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
export const PREFERENCES_FILE_VERSION = 3 as const

/**
 * One member of the provider chain.
 *
 * `model` omitted means the registry default for that provider, resolved at
 * construction rather than stored — so a member does not pin itself to whatever
 * the default happened to be on the day it was written.
 */
export interface ProviderChoice {
	readonly id: ProviderId
	readonly model?: string
}

export interface Preferences {
	readonly version: 3
	/**
	 * The chain, in the operator's declared order. Index 0 is the primary and is
	 * the one that runs. Never empty — an empty chain is refused at read and at
	 * write, because it describes a namzu that cannot call anything while
	 * looking like a configured one.
	 */
	readonly providers: readonly ProviderChoice[]
	/**
	 * The operator has accepted a chain whose members declare different
	 * capabilities.
	 *
	 * Absent (the default), such a chain is REFUSED with the disagreement named.
	 * Taking the strongest declaration would advertise abilities a fallback does
	 * not have; taking the weakest would cost the primary a capability on every
	 * run to guard against a rare failure. Neither is chosen on the operator's
	 * behalf.
	 *
	 * Set, the chain runs and the disagreement is printed on every launch — not
	 * once. An acceptance given once and then forgotten is how a silent
	 * degradation comes back through the front door.
	 */
	readonly allowCapabilityMismatch?: boolean
	readonly subagents?: { readonly active: readonly string[] }
}

/**
 * How a member is named to the operator, by position.
 *
 * One function because three surfaces say it — validation, the doctor listing
 * and the capability refusal — and a chain member called `fallback #1` in one
 * message and `fallback 1` in the next reads as two different things.
 */
export function chainPositionName(index: number): string {
	return index === 0 ? 'primary provider' : `fallback #${index}`
}

export type ReadResult =
	| { readonly status: 'ok'; readonly prefs: Preferences }
	| { readonly status: 'missing' }
	| { readonly status: 'needs-repick'; readonly reason: string }

export class PreferencesError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PreferencesError'
	}
}

/**
 * The member that actually runs.
 *
 * A helper rather than `prefs.providers[0]` at each call site: the chain is
 * guaranteed non-empty by validation, and every reader repeating an index
 * lookup plus a non-null assertion would be four places to get that wrong.
 */
export function primaryProvider(prefs: Preferences): ProviderChoice {
	// Optional-chained rather than indexed: a caller handing over an object of
	// the old shape is a real case (a stale test fixture did exactly that), and
	// a `TypeError: cannot read '0' of undefined` names neither the field nor
	// the fix, while the error below names both.
	const first = prefs.providers?.[0]
	if (!first) {
		// Unreachable through readPreferences/writePreferences, both of which
		// refuse an empty chain. Reachable only from a hand-built object, and
		// silently returning a placeholder there would put the caller on a
		// provider nobody chose.
		throw new PreferencesError('preferences.providers is empty — no provider to run')
	}
	return first
}

export function preferencesPath(home: string = homedir()): string {
	return join(home, '.namzu', 'preferences.json')
}

export function readPreferences(home: string = homedir()): ReadResult {
	const path = preferencesPath(home)
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' }
		throw new PreferencesError(
			`could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (err) {
		throw new PreferencesError(
			`${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	if (typeof parsed !== 'object' || parsed === null) {
		throw new PreferencesError(`${path} top-level must be an object`)
	}
	const v = parsed as { version?: unknown }
	if (v.version === 1) {
		return {
			status: 'needs-repick',
			reason:
				'preferences file uses an older schema (v1) — namzu now picks an LLM provider client directly. Please re-pick.',
		}
	}
	if (v.version === 2) {
		const migrated = migrateV2(parsed)
		if (!migrated) {
			throw new PreferencesError(`${path} has an unexpected shape for a v2 file`)
		}
		const invalid = describeInvalidChain(migrated.providers)
		if (invalid) return { status: 'needs-repick', reason: `${invalid} — please re-pick.` }
		return { status: 'ok', prefs: migrated }
	}
	if (v.version !== PREFERENCES_FILE_VERSION) {
		return {
			status: 'needs-repick',
			reason: `preferences file at unsupported version ${String(v.version)} — please re-pick.`,
		}
	}
	if (!isPreferences(parsed)) {
		throw new PreferencesError(`${path} has an unexpected shape`)
	}
	// Shape is right; the CONTENT may still name a provider that does not exist
	// or repeat a member. Reported as `needs-repick` with the offending member
	// named, not thrown: a bad chain is something the operator can fix by
	// picking again, and it is the tail this is really for — an unusable
	// fallback that only surfaces the day the primary goes down is the failure
	// this check exists to prevent.
	const invalid = describeInvalidChain(parsed.providers)
	if (invalid) return { status: 'needs-repick', reason: `${invalid} — please re-pick.` }
	return { status: 'ok', prefs: parsed }
}

export function writePreferences(prefs: Preferences, home: string = homedir()): void {
	if (prefs.version !== PREFERENCES_FILE_VERSION) {
		throw new PreferencesError(
			`unsupported preferences version: ${String(prefs.version)} (expected ${PREFERENCES_FILE_VERSION})`,
		)
	}
	if (!Array.isArray(prefs.providers) || prefs.providers.length === 0) {
		throw new PreferencesError('preferences.providers must list at least one provider')
	}
	const invalid = describeInvalidChain(prefs.providers)
	if (invalid) throw new PreferencesError(invalid)

	const path = preferencesPath(home)
	mkdirSync(dirname(path), { recursive: true, mode: DIR_MODE })
	const body = `${JSON.stringify(prefs, null, 2)}\n`
	const tmp = `${path}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`
	writeFileSync(tmp, body, { mode: FILE_MODE })
	chmodSync(tmp, FILE_MODE)
	renameSync(tmp, path)
}

/**
 * A v2 file as a one-element chain, or null if it was not a well-formed v2.
 *
 * `model` is carried only when present, so a v2 file that never pinned a model
 * does not gain one.
 */
function migrateV2(value: unknown): Preferences | null {
	const v = value as Record<string, unknown>
	if (typeof v.provider !== 'string' || v.provider.length === 0) return null
	if (v.model !== undefined && typeof v.model !== 'string') return null
	if (!isSubagents(v.subagents)) return null
	const member: ProviderChoice = {
		id: v.provider as ProviderId,
		...(typeof v.model === 'string' ? { model: v.model } : {}),
	}
	return {
		version: PREFERENCES_FILE_VERSION,
		providers: [member],
		...(v.subagents !== undefined
			? { subagents: v.subagents as { readonly active: readonly string[] } }
			: {}),
	}
}

/**
 * Why this chain is unusable, or null if it is fine.
 *
 * Every member is checked, not only the head. A chain exists to be fallen back
 * to, so a tail member naming a provider that does not exist is precisely as
 * broken as a bad head — it is just broken later, on the worst day.
 */
function describeInvalidChain(members: readonly ProviderChoice[]): string | null {
	if (members.length === 0) {
		return 'preferences lists no providers'
	}
	const seen = new Set<string>()
	for (const [index, member] of members.entries()) {
		const position = chainPositionName(index)
		if (!(member.id in PROVIDER_REGISTRY)) {
			return `${position} "${member.id}" is not a provider namzu knows (known: ${Object.keys(PROVIDER_REGISTRY).join(', ')})`
		}
		// Compared as the pair the operator WROTE, not against the resolved
		// default model. Resolving would make a file that was valid yesterday
		// invalid the day a registry default changes, which is a config that
		// breaks on upgrade. Two entries for one provider with different models
		// stay legitimate: falling back from a large model to a small one on the
		// same provider is a real chain.
		const key = JSON.stringify([member.id, member.model ?? null])
		if (seen.has(key)) {
			const shown = member.model ? `${member.id} (${member.model})` : member.id
			return `${position} repeats "${shown}", which is already earlier in the chain — a provider cannot be its own fallback`
		}
		seen.add(key)
	}
	return null
}

function isSubagents(value: unknown): boolean {
	if (value === undefined) return true
	if (typeof value !== 'object' || value === null) return false
	const sa = value as Record<string, unknown>
	if (!Array.isArray(sa.active)) return false
	for (const item of sa.active) {
		if (typeof item !== 'string') return false
	}
	return true
}

function isProviderChoice(value: unknown): value is ProviderChoice {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	if (typeof v.id !== 'string' || v.id.length === 0) return false
	if (v.model !== undefined && typeof v.model !== 'string') return false
	return true
}

function isPreferences(value: unknown): value is Preferences {
	if (typeof value !== 'object' || value === null) return false
	const v = value as Record<string, unknown>
	if (v.version !== PREFERENCES_FILE_VERSION) return false
	if (!Array.isArray(v.providers)) return false
	for (const member of v.providers) {
		if (!isProviderChoice(member)) return false
	}
	if (v.allowCapabilityMismatch !== undefined && typeof v.allowCapabilityMismatch !== 'boolean') {
		return false
	}
	if (!isSubagents(v.subagents)) return false
	return true
}
