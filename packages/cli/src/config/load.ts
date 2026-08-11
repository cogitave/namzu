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
 *
 * A file that is not there contributes nothing, and that is a default. A file
 * that IS there and cannot be read throws {@link ConfigLoadError} — this loader
 * has no way to say "some of your settings", and will not pretend the ones it
 * failed to read were never written.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse as yamlParse } from 'yaml'

import type { McpServersConfig } from '../integrations/mcp/servers.js'
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

/**
 * A config file namzu could not read.
 *
 * Its own class rather than a bare `Error` so `cli.ts` can print the message on
 * its own and exit `EXIT_BAD_CONFIG`, instead of the stack trace an internal
 * error deserves and an operator's typo does not.
 */
export class ConfigLoadError extends Error {
	/** The file whose contents could not be established. */
	readonly path: string

	constructor(path: string, message: string, options?: { cause?: unknown }) {
		super(message, options)
		this.name = 'ConfigLoadError'
		this.path = path
	}
}

function readYamlIfExists(path: string): MutableConfig {
	const raw = readIfPresent(path)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = yamlParse(raw)
	} catch (cause) {
		throw new ConfigLoadError(path, `${path} is not valid YAML: ${reasonOf(cause)}`, { cause })
	}
	return asConfigObject(path, parsed)
}

function readJsonIfExists(path: string): MutableConfig {
	const raw = readIfPresent(path)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (cause) {
		throw new ConfigLoadError(path, `${path} is not valid JSON: ${reasonOf(cause)}`, { cause })
	}
	return asConfigObject(path, parsed)
}

/**
 * The file's text, or `null` when the file is genuinely not there.
 *
 * Absent and unreadable used to share one `catch`, and the shared answer was
 * `{}` — "no settings". For a file nobody wrote that is the right default. For
 * one that exists and could not be opened it is the wrong one, and wrong in the
 * direction that never announces itself: `permissions` is read from these files,
 * so an unreadable config becomes an empty rule table, and a headless run
 * resolves every call no rule covered to `auto`. The operator's deny list
 * becomes approval of the same calls, on the one path where nobody is watching.
 *
 * So only "the file is not there" reads as no settings. `ENOENT` is the file
 * itself missing; `ENOTDIR` is a parent that is not a directory, which means the
 * same thing — nothing was ever written at that path. A permission error, a
 * directory where a file belongs, or an I/O failure all mean the file exists and
 * its contents could not be established, and that is a refusal.
 *
 * See `docs/conventions/an-optional-dependency-may-not-degrade-a-check.md`: the
 * degradation that matters is the one turning "I cannot establish this" into
 * "this is satisfied".
 */
function readIfPresent(path: string): string | null {
	try {
		return readFileSync(path, 'utf8')
	} catch (cause) {
		const code = (cause as NodeJS.ErrnoException | null)?.code
		if (code === 'ENOENT' || code === 'ENOTDIR') return null
		throw new ConfigLoadError(path, `${path} could not be read: ${reasonOf(cause)}`, { cause })
	}
}

/**
 * The parsed document as a config object, refusing anything that is not one.
 *
 * An empty file parses to `null`, and that is a genuine "no settings" — a file
 * someone emptied says nothing, which is what it looks like. A scalar or a list
 * is different: it is content namzu cannot read as settings, and admitting it as
 * `{}` is the same fail-open as the unreadable file one function up, reached by
 * a different route.
 */
function asConfigObject(path: string, parsed: unknown): MutableConfig {
	if (parsed === null || parsed === undefined) return {}
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new ConfigLoadError(
			path,
			`${path} must contain a mapping of settings, but its top level is ${describe(parsed)}`,
		)
	}
	return sanitize(parsed)
}

function describe(value: unknown): string {
	return Array.isArray(value) ? 'a list' : `a ${typeof value}`
}

function reasonOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
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
	// Shape only, for the same reason as `permissions`: an entry that names
	// neither a command nor a url — or both — is reported by name when the
	// connection is attempted. Dropping it here would turn a mistake the
	// operator can see into a server that silently was never there.
	mcpServers: (v) =>
		typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as McpServersConfig) : undefined,
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

function sanitize(value: object): MutableConfig {
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
