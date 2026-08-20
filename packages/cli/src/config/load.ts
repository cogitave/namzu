/**
 * Config cascade and runtime admission for @namzu/cli.
 *
 * Resolution order (highest priority first):
 *   1. CLI flags (handled by Commander, merged in `cli.ts`)
 *   2. Environment variables prefixed `NAMZU_`
 *   3. Project config: `./namzu.config.json` (TS variant added in a later
 *      milestone when a build step is justified)
 *   4. User config: `~/.namzu/config.yaml`
 *   5. Built-in defaults from `schema.ts`
 *
 * This module owns steps 2–5. CLI-flag merging happens in `cli.ts`, where
 * Commander knows what was explicitly set rather than merely defaulted.
 *
 * A file that is not there contributes nothing, and that is a default. A file
 * that IS there and cannot be read throws {@link ConfigLoadError} — this loader
 * has no way to say "some of your settings", and will not pretend the ones it
 * failed to read were never written.
 *
 * A source Namzu can parse but whose known key carries an invalid value throws
 * {@link ConfigValueError}. Absence, syntax failure, and semantic rejection are
 * three different states and none is represented by another.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { parse as yamlParse } from 'yaml'

import type { McpServersConfig } from '../integrations/mcp/servers.js'
import { isFormatName } from '../output/index.js'
import type { PermissionChecksConfig } from '../permissions/checks.js'
import type { PermissionsConfig } from '../permissions/rules.js'
import { configMetadataLiteral } from './debug.js'
import type {
	ProfileConfig,
	ProfilesConfig,
	SessionExportRedactorName,
	TerminalNotificationEvent,
} from './schema.js'
import { DEFAULT_CONFIG, type NamzuCliConfig } from './schema.js'

export interface LoadConfigOptions {
	/** Override the user's home dir (testing). */
	readonly home?: string
	/** Override the project root (testing or non-cwd execution). */
	readonly cwd?: string
	/** Replacement env source (testing). */
	readonly env?: NodeJS.ProcessEnv
	/**
	 * Which profile to apply, if any.
	 *
	 * A name that no file declares is an ERROR rather than a no-op. Someone
	 * who typed `--profile revew` is running under settings they did not
	 * choose, and every reading of the run after that is wrong; the cost of
	 * refusing is one retyped word.
	 */
	readonly profile?: string
	/** Overridable for tests; defaults to {@link MANAGED_CONFIG_PATH}. */
	readonly managedPath?: string
}

/**
 * A machine-wide config that wins the cascade.
 *
 * It exists for the case where the person running namzu is not the person
 * deciding what it may do — a shared build machine, a managed workstation.
 * Applied LAST, so it beats the project file and the environment both, which
 * is the only ordering that makes it worth having.
 *
 * **Its guarantee is the file system's and nothing more.** namzu does not
 * verify a signature, does not check an owner, and cannot tell an
 * administrator's file from one the user wrote there. What stops a user
 * editing it is that the path needs privileges they do not have, on a machine
 * somebody configured that way. That is a real control and a narrow one, and
 * stating it precisely is the difference between a security boundary and the
 * appearance of one.
 *
 * Absent on almost every machine, which is the expected case and not an error.
 */
export const MANAGED_CONFIG_PATH =
	process.platform === 'win32'
		? join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'namzu', 'config.json')
		: '/etc/namzu/config.json'

/**
 * A config value's source, one variant per cascade layer.
 *
 * `variable` on the `env` branch names which `NAMZU_*` variable actually won
 * — not just that env won — because two fields can each be read from a
 * different variable and "env" alone would not tell an operator which one to
 * change. `path` on the file branches is the resolved path actually read,
 * matching what `ConfigLoadError.path` would have named had that file failed
 * to parse instead of merging cleanly.
 */
export type ConfigSource =
	| { readonly kind: 'default' }
	| { readonly kind: 'user-file'; readonly path: string }
	| { readonly kind: 'project-file'; readonly path: string }
	/**
	 * A selected profile, and the file it was declared in.
	 *
	 * Both are named because neither alone answers the question an operator
	 * asks here. "profile" does not say which file to open, and the path does
	 * not say which of that file's profiles is in force.
	 */
	| { readonly kind: 'profile'; readonly name: string; readonly path: string }
	| { readonly kind: 'env'; readonly variable: string }
	/** A machine-wide file that wins the cascade; see `MANAGED_CONFIG_PATH`. */
	| { readonly kind: 'managed'; readonly path: string }

/**
 * Which `ConfigSource` won each key of the resolved config.
 *
 * A key absent from this map means no source set it, and that is different
 * from `{ kind: 'default' }`: `DEFAULT_CONFIG` does not carry every field
 * (`sandbox` has none), and fabricating a default source for a key nothing
 * actually defaulted would misreport a field as set when it is not.
 */
export type ConfigProvenance = {
	readonly [K in keyof NamzuCliConfig]?: ConfigSource
}

/**
 * `loadConfig` plus the record of who won each key.
 *
 * A second entry point rather than widening `loadConfig` itself:
 * `loadConfig` is exported from `../index.js` for embedded consumers, and
 * `(opts?: LoadConfigOptions) => NamzuCliConfig` is a signature something out
 * there may already depend on. `loadConfig` below is now defined in terms of
 * this function precisely so the two cannot drift apart — there is one merge
 * to reason about, not two copies of the same precedence logic kept in sync
 * by hand.
 */
export function loadConfigWithProvenance(opts: LoadConfigOptions = {}): {
	config: NamzuCliConfig
	provenance: ConfigProvenance
} {
	const home = opts.home ?? homedir()
	const cwd = opts.cwd ?? process.cwd()
	const env = opts.env ?? process.env

	const userPath = join(home, '.namzu', 'config.yaml')
	const projectPath = resolve(cwd, 'namzu.config.json')

	const managedPath = opts.managedPath ?? MANAGED_CONFIG_PATH

	const userCfg = readYamlIfExists(userPath)
	const projectCfg = readJsonIfExists(projectPath)
	const managedCfg = readJsonIfExists(managedPath)
	const { config: envCfg, variables: envVariables } = readEnv(env)

	// The command line first, then the environment. A flag is this run; a
	// variable is this shell — so the narrower statement wins, the way it does
	// everywhere else here.
	const profileName = opts.profile ?? env.NAMZU_PROFILE
	const profiles = profileLayers(profileName, [
		[userCfg, userPath],
		[projectCfg, projectPath],
		[managedCfg, managedPath],
	])

	return mergeConfigs(
		constantLayer(DEFAULT_CONFIG, { kind: 'default' }),
		constantLayer(userCfg, { kind: 'user-file', path: userPath }),
		constantLayer(projectCfg, { kind: 'project-file', path: projectPath }),
		// After both files and before the environment. A profile is a
		// deliberate choice about a set of settings, so it beats the ambient
		// values in the file it came from; a variable is a statement about this
		// one shell, so it beats the profile.
		...profiles,
		{
			config: envCfg,
			sourceFor: (key) => {
				const variable = envVariables[key]
				// `readEnv` sets `variables[key]` in the same branch it sets
				// `config[key]` — see `ENV_VARIABLE_NAMES` — so this is defined
				// for every key this layer's config actually carries. Reaching
				// `undefined` here means that pairing broke, which is a bug in
				// this file, not a malformed environment.
				if (variable === undefined) {
					throw new Error(`no env variable recorded for config key '${key}'`)
				}
				return { kind: 'env', variable }
			},
		},
		// Last, so it beats the project file and the environment both. That
		// ordering is the whole of what a managed layer is.
		constantLayer(managedCfg, { kind: 'managed', path: managedPath }),
	)
}

/**
 * The selected profile, once per file that declares it.
 *
 * One layer per file rather than one merged layer, so provenance keeps naming
 * the file a value actually came from — a project profile overriding a user
 * profile of the same name is the ordinary case, and reporting both as "the
 * profile" would leave an operator opening the wrong file.
 *
 * Refuses a name nothing declares. The alternative is a run under settings
 * nobody chose, reported as success.
 */
function profileLayers(
	name: string | undefined,
	files: readonly (readonly [MutableConfig, string])[],
): ConfigLayer[] {
	if (name === undefined || name === '') return []

	const layers: ConfigLayer[] = []
	const declared = new Set<string>()
	const declaringFiles: string[] = []
	for (const [config, path] of files) {
		const profiles = config.profiles
		if (profiles === undefined) continue
		declaringFiles.push(path)
		for (const key of Object.keys(profiles)) declared.add(key)
		if (!Object.hasOwn(profiles, name)) continue
		const selected = profiles[name]
		// `Object.hasOwn` above is the declaration check. Direct indexing alone
		// admits inherited `toString`, `constructor`, and `__proto__` as profiles
		// a file never declared.
		if (selected === undefined) continue
		layers.push(constantLayer(selected as MutableConfig, { kind: 'profile', name, path }))
	}

	if (layers.length === 0) {
		const known = [...declared].sort()
		// The path is where to go and fix it. A file that already declares
		// profiles is the better answer than the one bound to this folder,
		// because a misspelled name usually sits next to the right one — and
		// when nothing declares any, the folder's own file is where the first
		// one would go.
		const where = declaringFiles[0] ?? files[1]?.[1] ?? ''
		throw new ConfigLoadError(
			where,
			known.length === 0
				? `No profile named "${name}" — no config file declares any profiles.`
				: `No profile named "${name}". Declared in ${declaringFiles.join(', ')}: ${known.join(', ')}.`,
		)
	}
	return layers
}

export function loadConfig(opts: LoadConfigOptions = {}): NamzuCliConfig {
	return loadConfigWithProvenance(opts).config
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

/** The explicit source that supplied a semantically invalid config value. */
export type ConfigValueSource =
	| { readonly kind: 'file'; readonly path: string }
	| { readonly kind: 'environment'; readonly variable: string }

/**
 * A known config key whose explicit value does not satisfy its public type.
 *
 * Kept distinct from {@link ConfigLoadError}: that class means a file could
 * not be read or parsed at all, while this one means the source was readable
 * and named a setting Namzu cannot honour. Public loaders throw both; the
 * standalone binary maps both to `EX_CONFIG`.
 */
export class ConfigValueError extends Error {
	readonly source: ConfigValueSource
	/** Dot/bracket path to the invalid known setting, without its source. */
	readonly settingPath: string

	constructor(source: ConfigValueSource, settingPath: string, message: string) {
		const origin =
			source.kind === 'file'
				? `config file ${configMetadataLiteral(source.path)}`
				: `environment variable ${source.variable}`
		super(`${origin}: ${settingPath} ${message}`)
		this.name = 'ConfigValueError'
		this.source = source
		this.settingPath = settingPath
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
	return sanitize(parsed, { kind: 'file', path })
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

type SettingPathSegment = string | number

interface ConfigReaderContext {
	readonly source: ConfigValueSource
	readonly path: readonly SettingPathSegment[]
}

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
	[K in keyof Required<NamzuCliConfig>]: (
		value: unknown,
		context: ConfigReaderContext,
	) => NamzuCliConfig[K]
}

const CONFIG_READERS: ConfigReaders = {
	format: (v, context) => {
		if (typeof v === 'string' && isFormatName(v)) return v
		return invalidConfigValue(context, [], 'must be one of "text", "json", or "yaml"')
	},
	quiet: (v, context) => {
		if (typeof v === 'boolean') return v
		return invalidConfigValue(context, [], 'must be a boolean')
	},
	// Shape only. Per-entry validation belongs to `compilePermissions`, which
	// reports a bad effect or an unusable pattern as a diagnostic the user
	// sees; dropping those entries here would silence it.
	permissions: (v, context) => {
		if (isConfigMapping(v)) return v as PermissionsConfig
		return invalidConfigValue(context, [], 'must be a mapping of tool names')
	},
	// Shape only, like `permissions` and for the same reason: per-entry
	// validation belongs to `verifyPermissionChecks`, which reports a bad
	// check by index. Dropping a malformed one here would turn "your check is
	// unreadable" into "your check passed".
	permissionChecks: (v, context) => {
		if (Array.isArray(v)) return v as PermissionChecksConfig
		return invalidConfigValue(context, [], 'must be a list')
	},
	// Every declared profile is checked when its file loads, not only when it is
	// selected. Typed config in a lower-precedence layer cannot become valid
	// merely because another layer happens to win today. Unknown profile keys
	// remain non-strict and are ignored by `sanitize`, like unknown base keys.
	profiles: (v, context) => {
		if (!isConfigMapping(v)) {
			return invalidConfigValue(context, [], 'must be a mapping of profile names')
		}
		const profiles: Record<string, ProfileConfig> = {}
		for (const name of Object.keys(v)) {
			const entry = v[name]
			if (!isConfigMapping(entry)) {
				return invalidConfigValue(context, [name], 'must be a mapping of settings')
			}
			const parsed = sanitize(entry, context.source, [...context.path, name], false)
			// Define rather than assign: `__proto__` is a valid own profile name,
			// not permission to change this dictionary's prototype.
			Object.defineProperty(profiles, name, {
				value: parsed as ProfileConfig,
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
		return profiles as ProfilesConfig
	},
	// Shape only, for the same reason as `permissions`: an entry that names
	// neither a command nor a url — or both — is reported by name when the
	// connection is attempted. Dropping it here would turn a mistake the
	// operator can see into a server that silently was never there.
	mcpServers: (v, context) => {
		if (isConfigMapping(v)) return v as McpServersConfig
		return invalidConfigValue(context, [], 'must be a mapping of server names')
	},
	// Read field by field rather than shape-only, unlike the two above.
	// Those hand their entries to a compiler that reports a bad one by name;
	// this one is consumed directly, and a misspelled `require_isolation` or
	// a string where a list belongs would otherwise become "no requirement"
	// — a security control silently downgraded by a typo, which is the
	// failure this whole change exists to remove.
	sandbox: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const raw = v as {
			enabled?: unknown
			requireIsolation?: unknown
			teardownTimeoutMs?: unknown
		}
		if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
			return invalidConfigValue(context, ['enabled'], 'must be a boolean')
		}
		if (raw.requireIsolation !== undefined && !Array.isArray(raw.requireIsolation)) {
			return invalidConfigValue(context, ['requireIsolation'], 'must be a list')
		}
		const requireIsolation = raw.requireIsolation as unknown[] | undefined
		const invalidIndex = requireIsolation?.findIndex(
			(value) => value !== 'filesystem' && value !== 'network' && value !== 'process',
		)
		if (invalidIndex !== undefined && invalidIndex >= 0) {
			return invalidConfigValue(
				context,
				['requireIsolation', invalidIndex],
				'must be one of "filesystem", "network", or "process"',
			)
		}
		if (
			raw.teardownTimeoutMs !== undefined &&
			(!Number.isInteger(raw.teardownTimeoutMs) ||
				(raw.teardownTimeoutMs as number) < 0 ||
				(raw.teardownTimeoutMs as number) > 2_147_483_647)
		) {
			return invalidConfigValue(
				context,
				['teardownTimeoutMs'],
				'must be an integer from 0 to 2147483647',
			)
		}
		return {
			...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
			...(requireIsolation !== undefined
				? {
						requireIsolation: requireIsolation as readonly ('filesystem' | 'network' | 'process')[],
					}
				: {}),
			...(raw.teardownTimeoutMs !== undefined
				? { teardownTimeoutMs: raw.teardownTimeoutMs as number }
				: {}),
		}
	},
	// Field by field, for the same reason as `sandbox` and one stronger:
	// this one decides whether conversation content leaves the machine. A
	// misspelled `redacters` read shape-only could change the export's security
	// posture while it still ran. A malformed known field therefore refuses the
	// config rather than selecting either "off" or a different redactor set.
	telemetry: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const raw = v as { sessionExport?: unknown }
		if (raw.sessionExport === undefined) return {}
		const se = raw.sessionExport
		if (!isConfigMapping(se)) {
			return invalidConfigValue(context, ['sessionExport'], 'must be a mapping')
		}
		const entry = se as { destination?: unknown; eventTypes?: unknown; redactors?: unknown }

		// No destination, no export. There is nothing to fall back to and
		// nothing safe to guess.
		if (typeof entry.destination !== 'string' || entry.destination.length === 0) {
			return invalidConfigValue(
				context,
				['sessionExport', 'destination'],
				'must be a non-empty string',
			)
		}

		let eventTypes: readonly string[] | undefined
		if (entry.eventTypes !== undefined) {
			if (!Array.isArray(entry.eventTypes)) {
				return invalidConfigValue(context, ['sessionExport', 'eventTypes'], 'must be a list')
			}
			const invalidIndex = entry.eventTypes.findIndex((event) => typeof event !== 'string')
			if (invalidIndex >= 0) {
				return invalidConfigValue(
					context,
					['sessionExport', 'eventTypes', invalidIndex],
					'must be a string',
				)
			}
			eventTypes = entry.eventTypes as readonly string[]
		}

		let redactors: readonly SessionExportRedactorName[] | undefined
		if (entry.redactors !== undefined) {
			if (!Array.isArray(entry.redactors)) {
				return invalidConfigValue(context, ['sessionExport', 'redactors'], 'must be a list')
			}
			const invalidIndex = entry.redactors.findIndex((redactor) => redactor !== 'secrets')
			if (invalidIndex >= 0) {
				return invalidConfigValue(
					context,
					['sessionExport', 'redactors', invalidIndex],
					'must be "secrets"',
				)
			}
			redactors = entry.redactors as readonly SessionExportRedactorName[]
		}

		return {
			sessionExport: {
				destination: entry.destination,
				...(eventTypes !== undefined ? { eventTypes } : {}),
				...(redactors !== undefined ? { redactors } : {}),
			},
		}
	},
	// TUI notifications are terminal escape writes only. Invalid nested values
	// refuse rather than silently selecting a different event/protocol or
	// disabling the feature the operator explicitly configured.
	tui: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const raw = v as { notifications?: unknown; notificationMethod?: unknown }

		let notifications: boolean | readonly TerminalNotificationEvent[] | undefined
		if (typeof raw.notifications === 'boolean') notifications = raw.notifications
		else if (Array.isArray(raw.notifications)) {
			const invalidIndex = raw.notifications.findIndex(
				(event) => event !== 'turn-settled' && event !== 'approval-required',
			)
			if (invalidIndex >= 0) {
				return invalidConfigValue(
					context,
					['notifications', invalidIndex],
					'must be one of "turn-settled" or "approval-required"',
				)
			}
			notifications = raw.notifications as readonly TerminalNotificationEvent[]
		} else if (raw.notifications !== undefined) {
			return invalidConfigValue(context, ['notifications'], 'must be a boolean or a list')
		}

		const method = raw.notificationMethod
		if (method !== undefined && method !== 'osc9' && method !== 'bel') {
			return invalidConfigValue(context, ['notificationMethod'], 'must be "osc9" or "bel"')
		}

		return {
			...(notifications !== undefined ? { notifications } : {}),
			...(method !== undefined ? { notificationMethod: method } : {}),
		}
	},
}

/**
 * Which `NAMZU_*` variable a field reads from, or `undefined` when env does
 * not set it at all.
 *
 * A mapped type over every field of `NamzuCliConfig`, like `ConfigReaders`
 * below — total, so a field added to the public config type forces a
 * decision here too: name the variable, or say explicitly `undefined`
 * because env does not carry it. `readEnv` reads this table rather than a
 * literal string, so the variable name recorded in a `ConfigSource` can
 * never drift from the one `readEnv` actually checked.
 */
type EnvVariableNames = {
	readonly [K in keyof Required<NamzuCliConfig>]: string | undefined
}

export const ENV_VARIABLE_NAMES: EnvVariableNames = {
	format: 'NAMZU_FORMAT',
	quiet: 'NAMZU_QUIET',
	permissions: undefined,
	// Deliberately not env-settable, and for a sharper reason than the rest:
	// a variable that could replace the checks could also empty them, which
	// would silence the one thing that says a policy stopped meaning what its
	// author wrote — from a shell profile, with nothing in the config file to
	// show for it.
	permissionChecks: undefined,
	// The SET of profiles is not env-settable — it is the thing being chosen
	// BETWEEN, and a variable that could replace it could hand a shell a
	// profile the files never declared. `NAMZU_PROFILE` selects one of the
	// declared profiles and is read in the cascade rather than here, because
	// it does not set a config field.
	profiles: undefined,
	mcpServers: undefined,
	sandbox: undefined,
	// Deliberately not env-settable. A `NAMZU_TELEMETRY_SESSION_EXPORT=/tmp/x`
	// in a shell profile would start exporting conversation content with
	// nothing in the config file to show for it — the disclosure would be
	// honest and the *reason* would be invisible.
	telemetry: undefined,
	// Terminal notifications are an interactive UI choice. An environment
	// variable in a shell profile must not start producing them invisibly.
	tui: undefined,
}

/** Which `NAMZU_*` variable actually set each field `readEnv` found. */
type EnvVariablesUsed = { -readonly [K in keyof NamzuCliConfig]?: string }

function readEnv(env: NodeJS.ProcessEnv): { config: MutableConfig; variables: EnvVariablesUsed } {
	const config: MutableConfig = {}
	const variables: EnvVariablesUsed = {}

	const formatVar = ENV_VARIABLE_NAMES.format
	if (formatVar) {
		const format = env[formatVar]
		if (format !== undefined) {
			if (!isFormatName(format)) {
				throw new ConfigValueError(
					{ kind: 'environment', variable: formatVar },
					'format',
					'must be one of "text", "json", or "yaml"',
				)
			}
			config.format = format
			variables.format = formatVar
		}
	}

	const quietVar = ENV_VARIABLE_NAMES.quiet
	if (quietVar) {
		const quiet = env[quietVar]
		if (quiet !== undefined) {
			if (quiet !== '1' && quiet !== 'true' && quiet !== '0' && quiet !== 'false') {
				throw new ConfigValueError(
					{ kind: 'environment', variable: quietVar },
					'quiet',
					'must be one of "1", "true", "0", or "false"',
				)
			}
			config.quiet = quiet === '1' || quiet === 'true'
			variables.quiet = quietVar
		}
	}

	return { config, variables }
}

function sanitize(
	value: object,
	source: ConfigValueSource,
	prefix: readonly SettingPathSegment[] = [],
	allowProfiles = true,
): MutableConfig {
	const v = value as Record<string, unknown>
	const out: MutableConfig = {}
	for (const key of Object.keys(CONFIG_READERS) as (keyof NamzuCliConfig)[]) {
		if (!Object.hasOwn(v, key)) continue
		if (key === 'profiles' && !allowProfiles) {
			throw new ConfigValueError(
				source,
				formatSettingPath([...prefix, key]),
				'cannot be declared inside a profile',
			)
		}
		const parsed = CONFIG_READERS[key](v[key], { source, path: [...prefix, key] })
		// One assignment through a widened view, rather than a cast on the
		// result: the key/reader pairing is what `ConfigReaders` proves.
		;(out as Record<string, unknown>)[key] = parsed
	}
	return out
}

function isConfigMapping(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidConfigValue(
	context: ConfigReaderContext,
	suffix: readonly SettingPathSegment[],
	message: string,
): never {
	throw new ConfigValueError(
		context.source,
		formatSettingPath([...context.path, ...suffix]),
		message,
	)
}

function formatSettingPath(segments: readonly SettingPathSegment[]): string {
	let out = ''
	for (const segment of segments) {
		if (typeof segment === 'number') {
			out += `[${segment}]`
			continue
		}
		if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
			out += out === '' ? segment : `.${segment}`
			continue
		}
		out += `[${configMetadataLiteral(segment)}]`
	}
	return out
}

/**
 * One cascade layer: the fields it set, and where each one came from.
 *
 * `sourceFor` is a function rather than a constant `ConfigSource` because the
 * env layer cannot use one value for every key — `format` and `quiet` can
 * each come from a different `NAMZU_*` variable. The three file-derived
 * layers below use `constantLayer`, where every key shares one source.
 */
interface ConfigLayer {
	readonly config: MutableConfig
	/** Called only for keys this layer's own `config` actually set. */
	readonly sourceFor: (key: keyof NamzuCliConfig) => ConfigSource
}

function constantLayer(config: MutableConfig, source: ConfigSource): ConfigLayer {
	return { config, sourceFor: () => source }
}

/**
 * Merges cascade layers lowest-precedence first onto `MutableConfig`, with no
 * cast on the result — see that type's own doc comment for why the cast used
 * to be the bug this shape prevents. Still a per-key loop rather than
 * `Object.assign`, now for two reasons instead of one: the original reason (a
 * key `MutableConfig` cannot carry must fail to compile, not vanish) plus
 * recording `ConfigProvenance` in the same pass a key is written, so a key
 * can never land in one map and not the other.
 */
function mergeConfigs(...layers: readonly ConfigLayer[]): {
	config: NamzuCliConfig
	provenance: ConfigProvenance
} {
	const out: MutableConfig = {}
	const provenance: { -readonly [K in keyof NamzuCliConfig]?: ConfigSource } = {}
	for (const layer of layers) {
		for (const key of Object.keys(layer.config) as (keyof NamzuCliConfig)[]) {
			// Same widened-view assignment as `sanitize`: a cast on the target,
			// not the value, is what lets a generic key write onto a
			// heterogeneous mapped type without silently dropping a field this
			// function cannot carry.
			;(out as Record<string, unknown>)[key] = layer.config[key]
			provenance[key] = layer.sourceFor(key)
		}
	}
	return { config: out, provenance }
}
