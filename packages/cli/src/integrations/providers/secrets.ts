/**
 * Reader for clawtool's `~/.config/clawtool/secrets.toml`.
 *
 * Schema (per clawtool's `internal/config/portals_io.go`):
 *
 *   [secrets.work]
 *   ANTHROPIC_API_KEY = "sk-ant-..."
 *   OPENAI_API_KEY    = "sk-..."
 *
 *   [secrets.personal]
 *   OPENROUTER_API_KEY = "..."
 *
 * Namzu treats each `[secrets.X]` section as a candidate credential
 * bundle — the env-var keys inside are the same names as native env
 * vars (e.g. `ANTHROPIC_API_KEY`). We flatten every section into a
 * single `Map<envVarName, value[]>` so the discoverer can ask "does any
 * source have ANTHROPIC_API_KEY?" without caring which scope it came
 * from. Multiple sections can carry the same key; we keep all values
 * so the picker can present them as distinct candidates if the user
 * has multiple Anthropic accounts.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { parse as tomlParse } from 'smol-toml'

export interface SecretCandidate {
	/** Env-var name as it would appear at runtime (e.g. `ANTHROPIC_API_KEY`). */
	readonly envName: string
	readonly value: string
	/** Which `[secrets.X]` section it came from (e.g. `work`, `personal`). */
	readonly scope: string
}

export function clawtoolSecretsPath(home: string = homedir()): string {
	return join(home, '.config', 'clawtool', 'secrets.toml')
}

/**
 * Read clawtool's secrets.toml and return a flat array of every
 * env-var-style credential it carries, tagged by scope. Returns `[]`
 * when the file is missing or unparseable — never throws (this is an
 * optional discovery source).
 */
export function readClawtoolSecrets(home: string = homedir()): readonly SecretCandidate[] {
	const path = clawtoolSecretsPath(home)
	let raw: string
	try {
		raw = readFileSync(path, 'utf8')
	} catch {
		return []
	}
	let parsed: unknown
	try {
		parsed = tomlParse(raw)
	} catch {
		return []
	}
	if (typeof parsed !== 'object' || parsed === null) return []
	const root = parsed as Record<string, unknown>
	const secrets = root.secrets
	if (typeof secrets !== 'object' || secrets === null) return []
	const out: SecretCandidate[] = []
	for (const [scope, section] of Object.entries(secrets as Record<string, unknown>)) {
		if (typeof section !== 'object' || section === null) continue
		for (const [envName, value] of Object.entries(section as Record<string, unknown>)) {
			if (typeof value === 'string' && value.length > 0) {
				out.push({ envName, value, scope })
			}
		}
	}
	return out
}
