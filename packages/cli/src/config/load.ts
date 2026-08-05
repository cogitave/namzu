/**
 * Config cascade for @namzu/cli (M0 scaffolding).
 *
 * Resolution order (highest priority first):
 *   1. CLI flags (handled by Commander, merged in `bin.ts`)
 *   2. Environment variables prefixed `NAMZU_`
 *   3. Project config: `./namzu.config.json` (TS variant added in a later
 *      milestone when a build step is justified)
 *   4. User config: `~/.namzu/config.yaml`
 *   5. Built-in defaults from `schema.ts`
 *
 * In M0 we wire steps 2, 3, 4, 5. CLI-flag merging happens in `bin.ts`
 * where Commander knows what was explicitly set vs defaulted.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse as yamlParse } from 'yaml'

import { isFormatName } from '../output/index.js'
import type { PermissionsConfig } from '../permissions/rules.js'
import { DEFAULT_CONFIG, type NamzuCliConfig } from './schema.js'

export interface LoadConfigOptions {
	/** Override the user's home dir (testing). */
	readonly home?: string
	/** Override the project root (testing or non-cwd execution). */
	readonly cwd?: string
	/** Replacement env source (testing). */
	readonly env?: NodeJS.ProcessEnv
}

export function loadConfig(opts: LoadConfigOptions = {}): NamzuCliConfig {
	const home = opts.home ?? homedir()
	const cwd = opts.cwd ?? process.cwd()
	const env = opts.env ?? process.env

	const userPath = join(home, '.namzu', 'config.yaml')
	const projectPath = resolve(cwd, 'namzu.config.json')

	const userCfg = readYamlIfExists(userPath)
	const projectCfg = readJsonIfExists(projectPath)
	const envCfg = readEnv(env)

	return mergeConfigs(DEFAULT_CONFIG, userCfg, projectCfg, envCfg)
}

function readYamlIfExists(path: string): MutableConfig {
	const raw = safeRead(path)
	if (raw === null) return {}
	try {
		return sanitize(yamlParse(raw))
	} catch {
		return {}
	}
}

function readJsonIfExists(path: string): MutableConfig {
	const raw = safeRead(path)
	if (raw === null) return {}
	try {
		return sanitize(JSON.parse(raw))
	} catch {
		return {}
	}
}

/**
 * A writable mirror of the public config, derived from it rather than
 * restated.
 *
 * It used to be a hand-written pair of fields, and `mergeConfigs` ended in
 * `out as NamzuCliConfig` — so this type could omit a field the public config
 * declared and nothing complained. `permissions` was added to `NamzuCliConfig`,
 * could not be represented here, and was silently dropped from every config
 * file namzu read. The cast is what made that possible: it told the compiler to
 * stop checking exactly where the gap was.
 */
type MutableConfig = { -readonly [K in keyof NamzuCliConfig]?: NamzuCliConfig[K] }

/**
 * One reader per public config field. The mapped type has no `?`, so **every**
 * key of `NamzuCliConfig` must appear here — adding a field to the public
 * config now fails to compile until it is given a reader.
 *
 * That is the point. The previous version was an allowlist a new field had to
 * be manually added to, and the cost of forgetting was a config key that
 * parsed, validated, type-checked and did nothing.
 */
type ConfigReaders = {
	[K in keyof Required<NamzuCliConfig>]: (value: unknown) => NamzuCliConfig[K] | undefined
}

const CONFIG_READERS: ConfigReaders = {
	format: (v) => (typeof v === 'string' && isFormatName(v) ? v : undefined),
	quiet: (v) => (typeof v === 'boolean' ? v : undefined),
	// Shape only. Per-entry validation belongs to `compilePermissions`, which
	// reports a bad effect or an unusable pattern as a diagnostic the user
	// sees; dropping those entries here would silence it.
	permissions: (v) =>
		typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as PermissionsConfig) : undefined,
}

function readEnv(env: NodeJS.ProcessEnv): MutableConfig {
	const out: MutableConfig = {}
	const format = env.NAMZU_FORMAT
	if (format && isFormatName(format)) {
		out.format = format
	}
	const quiet = env.NAMZU_QUIET
	if (quiet === '1' || quiet === 'true') out.quiet = true
	if (quiet === '0' || quiet === 'false') out.quiet = false
	return out
}

function sanitize(value: unknown): MutableConfig {
	if (typeof value !== 'object' || value === null) return {}
	const v = value as Record<string, unknown>
	const out: MutableConfig = {}
	for (const key of Object.keys(CONFIG_READERS) as (keyof NamzuCliConfig)[]) {
		if (!(key in v)) continue
		const parsed = CONFIG_READERS[key](v[key])
		// One assignment through a widened view, rather than a cast on the
		// result: the key/reader pairing is what `ConfigReaders` proves.
		if (parsed !== undefined) (out as Record<string, unknown>)[key] = parsed
	}
	return out
}

// Returns `MutableConfig`, which is assignable to `NamzuCliConfig` because it
// is derived from it. No cast — a field this function cannot carry is now a
// compile error rather than a value that quietly never arrives.
function mergeConfigs(...sources: readonly MutableConfig[]): NamzuCliConfig {
	const out: MutableConfig = {}
	for (const src of sources) Object.assign(out, src)
	return out
}

function safeRead(path: string): string | null {
	try {
		return readFileSync(path, 'utf8')
	} catch {
		return null
	}
}
