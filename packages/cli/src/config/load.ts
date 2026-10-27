/**
 * Config cascade and runtime admission for @namzu/cli.
 *
 * Resolution order (highest priority first):
 *   1. CLI flags (handled by Commander, merged in `cli.ts`)
 *   2. Environment variables prefixed `NAMZU_`
 *   3. Local config: `./namzu.config.local.json`, the project's own file that
 *      git ignores; where "don't ask again" answers are written
 *   4. Project config: `./namzu.config.json` (TS variant added in a later
 *      milestone when a build step is justified)
 *   5. User config: `$NAMZU_HOME/config.yaml` (`~/.namzu/config.yaml` by default)
 *   6. Built-in defaults from `schema.ts`
 *
 * This module owns steps 2–6. CLI-flag merging happens in `cli.ts`, where
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
import { basename, join, resolve } from 'node:path'
import { RENAMED_PLUGIN_HOOK_EVENTS, SHELL_HOOK_EVENTS } from '@namzu/sdk'

import { parse as yamlParse } from 'yaml'

import { splitProjectMcpServers } from '../integrations/mcp/project-approval.js'
import type { McpServersConfig } from '../integrations/mcp/servers.js'
import {
	McpServerFileError,
	PROJECT_MCP_FILE,
	readMcpServerFile,
} from '../integrations/mcp/shared-file.js'
import { resolveNamzuHome } from '../integrations/state/home.js'
import { isWorkflowSizeGuideline } from '../integrations/workflows/size.js'
import { isFormatName } from '../output/index.js'
import {
	type BrowserSiteLevel,
	canonicalBrowserSiteKey,
	isBrowserSiteLevel,
	narrower,
} from '../permissions/browser-sites.js'
import type { PermissionChecksConfig } from '../permissions/checks.js'
import { type PermissionsConfig, mergePermissionTables } from '../permissions/rules.js'
import {
	type SettingsAuthority,
	mergePermissionSettings,
	permissionSettingsProblem,
	splitPermissionsTable,
} from '../permissions/settings.js'
import { homePath } from '../tui/person-terms.js'
import { THEME_NAMES, parseThemeSetting } from '../tui/theme-palettes.js'
import {
	COMPOSER_TRIGGER_IDS,
	COMPOSER_TRIGGER_LANGUAGES,
	mergeComposerTriggers,
} from './composer-triggers.js'
import { configMetadataLiteral } from './debug.js'
import {
	MAX_LEARNING_TOKENS,
	MIN_LEARNING_TOKENS,
	mergeLearningGenerator,
} from './learning-generator.js'
import type {
	BrowserConfig,
	CodeAnalysisConfig,
	CompactionCliConfig,
	ComposerTriggerArming,
	ComposerTriggerId,
	ComposerTriggerLanguage,
	PluginConfig,
	ProfileConfig,
	ProfilesConfig,
	RoutingConfig,
	RoutingTarget,
	SessionExportRedactorName,
	TerminalNotificationEvent,
	TuiConfig,
	TurnLimitsConfig,
	WorkflowCliConfig,
} from './schema.js'
import {
	DEFAULT_CONFIG,
	type HookEntry,
	type HooksConfig,
	type NamzuCliConfig,
	type WebConfig,
} from './schema.js'
import {
	TOOL_RESULT_SCREEN_NAMES,
	TOOL_RESULT_SCREEN_OPTION_KEYS,
	type ToolResultScreenConfig,
	isToolResultScreenName,
} from './tool-result-screens.js'

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
	 * choose, and every reading of the turn after that is wrong; the cost of
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
	/** The project's git-ignored local file, over the project file; see {@link LOCAL_CONFIG_FILE}. */
	| { readonly kind: 'local-file'; readonly path: string }
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
	return resolveConfigWithProvenance(opts, {
		includeProject: true,
		deferUnknownProfile: false,
	})
}

/**
 * Resolve only process/user/managed authority before a project is trusted.
 *
 * Internal CLI seam: deliberately not re-exported from the package root. A
 * selected profile may be declared by the project layer, so an otherwise
 * unknown profile is deferred until the trusted, full resolution pass.
 */
export function loadBootstrapConfigWithProvenance(opts: LoadConfigOptions = {}): {
	config: NamzuCliConfig
	provenance: ConfigProvenance
} {
	return resolveConfigWithProvenance(opts, {
		includeProject: false,
		deferUnknownProfile: true,
	})
}

function resolveConfigWithProvenance(
	opts: LoadConfigOptions,
	mode: {
		readonly includeProject: boolean
		readonly deferUnknownProfile: boolean
	},
): {
	config: NamzuCliConfig
	provenance: ConfigProvenance
} {
	const cwd = opts.cwd ?? process.cwd()
	const env = opts.env ?? process.env

	const userPath = join(
		resolveNamzuHome({ ...(opts.home ? { home: opts.home } : {}), env }),
		'config.yaml',
	)
	const projectPath = resolve(cwd, 'namzu.config.json')
	const localPath = resolve(cwd, LOCAL_CONFIG_FILE)
	const sharedMcpPath = resolve(cwd, PROJECT_MCP_FILE)

	const managedPath = opts.managedPath ?? MANAGED_CONFIG_PATH

	const userCfg = readYamlIfExists(userPath)
	// `decision` points the agent at a network endpoint and names the env var
	// that holds a bearer token. A project's `namzu.config.json` is checked-in,
	// attacker-reachable config: honouring `decision` from it would let any repo
	// redirect the agent's decisions to its own endpoint and, for the azure
	// provider, exfiltrate the operator's Entra token to that endpoint. So it is
	// dropped from the project layer before validation — accepted only from the
	// user and managed layers, where where-to-send and which-credential-to-spend
	// is the operator's call, not the workspace's. `model: auto`, `routing` and
	// `smallModel` get the same treatment: they choose which provider and model receive the
	// conversation, and a repo must not redirect that. (A project profile still
	// carries it only when the operator selects that profile by name, an explicit
	// choice, not a drive-by.)
	const projectCfg = mode.includeProject
		? readJsonIfExists(projectPath, PROJECT_FILE_LABEL, [
				'decision',
				'model',
				'routing',
				'smallModel',
			])
		: {}
	// `.mcp.json`: the project's shared tool servers. Read under the same trust
	// as `namzu.config.json`, so a folder nobody has trusted starts none of
	// them. A server the project file also names keeps the project file's
	// entry; the rest are added.
	// A server in it starts only once the person approved that server for this
	// folder (and the entry still reads as it did then).
	const sharedServers = mode.includeProject
		? approvedSharedServers(
				readSharedMcpServers(sharedMcpPath),
				resolveNamzuHome({ ...(opts.home ? { home: opts.home } : {}), env }),
				cwd,
			)
		: undefined
	if (sharedServers && projectCfg.mcpServers !== undefined) {
		projectCfg.mcpServers = { ...sharedServers, ...projectCfg.mcpServers }
	}
	// The project's own file that git ignores: a person's answers for this
	// folder. Read under the same trust as the project file and held to the
	// same limits, since a folder that arrives as an archive can carry one.
	const localCfg = mode.includeProject
		? readJsonIfExists(localPath, LOCAL_FILE_LABEL, ['decision', 'model', 'routing'])
		: {}
	const managedCfg = readJsonIfExists(managedPath, shortHomePath(managedPath))
	const { config: envCfg, variables: envVariables } = readEnv(env)

	// The command line first, then the environment. A flag is this turn; a
	// variable is this shell — so the narrower statement wins, the way it does
	// everywhere else here.
	const profileName = opts.profile ?? env.NAMZU_PROFILE
	const profiles = profileLayers(
		profileName,
		[
			[userCfg, userPath],
			[projectCfg, projectPath],
			[localCfg, localPath],
			[managedCfg, managedPath],
		],
		mode.deferUnknownProfile,
	)

	const merged = mergeConfigs(
		constantLayer(DEFAULT_CONFIG, { kind: 'default' }),
		constantLayer(userCfg, { kind: 'user-file', path: userPath }),
		...(sharedServers && projectCfg.mcpServers === undefined
			? [
					constantLayer(
						asConfigObject(sharedMcpPath, { mcpServers: sharedServers }, SHARED_MCP_LABEL),
						{ kind: 'project-file', path: sharedMcpPath },
					),
				]
			: []),
		constantLayer(projectCfg, { kind: 'project-file', path: projectPath }),
		constantLayer(localCfg, { kind: 'local-file', path: localPath }),
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
	assertAutoModelHasDefault(merged.config, merged.provenance)
	return merged
}

/**
 * `model: auto` falls back to `routing.default` whenever it cannot decide, so
 * a config that asks for auto without one is refused here, at load, rather
 * than surfacing as a surprise on the first turn.
 */
function assertAutoModelHasDefault(config: NamzuCliConfig, provenance: ConfigProvenance): void {
	if (config.model !== 'auto' || config.routing !== undefined) return
	const source = provenance.model
	const valueSource: ConfigValueSource =
		source?.kind === 'env'
			? { kind: 'environment', variable: source.variable }
			: { kind: 'file', path: source && 'path' in source ? source.path : '(config)' }
	throw new ConfigValueError(
		valueSource,
		'model',
		'is "auto", which needs routing.default: the model auto falls back to',
	)
}

/** One file's `permissions` table, as it was written. */
export interface PermissionLayer {
	readonly source: 'user-file' | 'project-file' | 'local-file' | 'managed'
	readonly path: string
	readonly permissions: PermissionsConfig
	/**
	 * The sites the file's `browser.sites` denies, canonical (`*` left out).
	 * A scheduled run's browser grant cannot reopen one.
	 */
	readonly browserDenies?: readonly string[]
}

/**
 * The `permissions` table of each file that declares one: user, project and
 * managed, in cascade order, each on its own.
 *
 * The merged config cannot answer "did ANY file deny this": a project that
 * writes `bash = "allow"` replaces a user's `bash = "deny"` under the same key.
 * A scheduled run takes its allows from its job alone and the denies from
 * every file, so it needs the layers apart. Validated as the cascade
 * validates them; a file that fails to parse throws the same error.
 */
export function readPermissionLayers(
	opts: LoadConfigOptions & { readonly includeProject?: boolean } = {},
): PermissionLayer[] {
	const cwd = opts.cwd ?? process.cwd()
	const env = opts.env ?? process.env
	const userPath = join(
		resolveNamzuHome({ ...(opts.home ? { home: opts.home } : {}), env }),
		'config.yaml',
	)
	const projectPath = resolve(cwd, 'namzu.config.json')
	const localPath = resolve(cwd, LOCAL_CONFIG_FILE)
	const managedPath = opts.managedPath ?? MANAGED_CONFIG_PATH
	const layers: PermissionLayer[] = []
	for (const [source, path, config] of [
		['user-file', userPath, readYamlIfExists(userPath)],
		[
			'project-file',
			projectPath,
			opts.includeProject === false ? {} : readJsonIfExists(projectPath, PROJECT_FILE_LABEL),
		],
		[
			'local-file',
			localPath,
			opts.includeProject === false ? {} : readJsonIfExists(localPath, LOCAL_FILE_LABEL),
		],
		['managed', managedPath, readJsonIfExists(managedPath, shortHomePath(managedPath))],
	] as const) {
		const browserDenies = Object.entries(config.browser?.sites ?? {})
			.filter(([site, level]) => site !== '*' && level === 'deny')
			.map(([site]) => site)
		if (config.permissions || browserDenies.length > 0)
			layers.push({
				source,
				path,
				permissions: splitPermissionsTable(config.permissions ?? {}, 'operator', source).rules,
				...(browserDenies.length > 0 ? { browserDenies } : {}),
			})
	}
	return layers
}

/**
 * The selected profile, once per file that declares it.
 *
 * One layer per file rather than one merged layer, so provenance keeps naming
 * the file a value actually came from — a project profile overriding a user
 * profile of the same name is the ordinary case, and reporting both as "the
 * profile" would leave an operator opening the wrong file.
 *
 * Refuses a name nothing declares. The alternative is a turn under settings
 * nobody chose, reported as success.
 */
function profileLayers(
	name: string | undefined,
	files: readonly (readonly [MutableConfig, string])[],
	deferUnknown = false,
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
		if (deferUnknown) return []
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
	/** The message already says what to do next, so the caller adds no second line. */
	readonly complete: boolean

	constructor(path: string, message: string, options?: { cause?: unknown; complete?: boolean }) {
		super(message, options?.cause === undefined ? undefined : { cause: options.cause })
		this.name = 'ConfigLoadError'
		this.path = path
		this.complete = options?.complete === true
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
		const at = (cause as { linePos?: ReadonlyArray<{ line: number; col: number }> } | null)
			?.linePos?.[0]
		const where = at === undefined ? '' : ` (line ${at.line}, column ${at.col})`
		throw new ConfigLoadError(
			path,
			`${shortHomePath(path)} isn't valid YAML${where}. Fix it, then start Namzu again.`,
			{ cause, complete: true },
		)
	}
	return asConfigObject(path, parsed)
}

/** How the project's own file is named to a person: it is the one in the folder they are in. */
const PROJECT_FILE_LABEL = 'namzu.config.json in this project'
const SHARED_MCP_LABEL = '.mcp.json in this project'

function approvedSharedServers(
	declared: McpServersConfig | undefined,
	namzuHome: string,
	cwd: string,
): McpServersConfig | undefined {
	if (!declared) return undefined
	const { approved } = splitProjectMcpServers(namzuHome, cwd, declared)
	return Object.keys(approved).length > 0 ? approved : undefined
}

/**
 * The servers `.mcp.json` declares and the person has not yet approved for
 * this folder, with the declared table so a caller can record an answer.
 */
export function pendingProjectMcpServers(opts: {
	readonly cwd: string
	readonly home?: string
	readonly env?: NodeJS.ProcessEnv
}): { readonly declared: McpServersConfig; readonly pending: readonly string[] } {
	const declared = readSharedMcpServers(resolve(opts.cwd, PROJECT_MCP_FILE)) ?? {}
	const namzuHome = resolveNamzuHome({
		...(opts.home ? { home: opts.home } : {}),
		env: opts.env ?? process.env,
	})
	return { declared, pending: splitProjectMcpServers(namzuHome, opts.cwd, declared).pending }
}

/** The servers `.mcp.json` declares, or undefined when it has none or is absent. */
function readSharedMcpServers(path: string): McpServersConfig | undefined {
	try {
		const servers = readMcpServerFile(path, SHARED_MCP_LABEL)
		return servers && Object.keys(servers).length > 0 ? servers : undefined
	} catch (cause) {
		if (cause instanceof McpServerFileError) {
			throw new ConfigLoadError(path, cause.message, { cause, complete: true })
		}
		throw cause
	}
}

/**
 * The project's local config: the same settings as the project file, kept out
 * of git. It is where a "don't ask again" answer is written, and it sits over
 * the project file in the cascade (user < project < local < profile < env <
 * managed).
 */
export const LOCAL_CONFIG_FILE = 'namzu.config.local.json'
const LOCAL_FILE_LABEL = 'namzu.config.local.json in this project'

/** A path for a person to read: home as `~`, the way every other path on screen is shown. */
export function shortHomePath(path: string): string {
	return homePath(path)
}

function readJsonIfExists(
	path: string,
	label: string,
	/** Top-level keys dropped before validation, for keys a layer must not carry. */
	drop: readonly string[] = [],
): MutableConfig {
	const raw = readIfPresent(path)
	if (raw === null) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch (cause) {
		throw new ConfigLoadError(path, invalidJsonSentence(label, raw, cause), {
			cause,
			complete: true,
		})
	}
	if (drop.length > 0 && parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
		for (const key of drop) delete (parsed as Record<string, unknown>)[key]
	}
	return asConfigObject(path, parsed, label)
}

/**
 * Namzu's own sentence for a config file that is not JSON: the file's name, the
 * line and column the parser stopped at, and what to do. The parser's wording is
 * not part of it; it stays on the error's `cause` for `--debug`.
 */
function invalidJsonSentence(name: string, raw: string, cause: unknown): string {
	const position = jsonErrorPosition(raw, cause)
	let where = ''
	if (position !== undefined) {
		const before = raw.slice(0, position)
		const line = before.split('\n').length
		const column = position - (before.lastIndexOf('\n') + 1) + 1
		where = ` (line ${line}, column ${column})`
	}
	return `${name} isn't valid JSON${where}. Fix it, then start Namzu again.`
}

function jsonErrorPosition(raw: string, cause: unknown): number | undefined {
	const text = cause instanceof Error ? cause.message : String(cause)
	const at = /position (\d+)/.exec(text)
	if (at) return Math.min(Number(at[1]), raw.length)
	if (/end of JSON input/i.test(text)) return raw.length
	return undefined
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
 * See "an optional dependency may not degrade a check": the
 * degradation that matters is the one turning "I cannot establish this" into
 * "this is satisfied".
 */
function readIfPresent(path: string): string | null {
	try {
		// Windows editors save UTF-8 with a leading byte-order mark, which JSON.parse
		// and the YAML parser both refuse as a stray character. It is not content.
		return stripByteOrderMark(readFileSync(path, 'utf8'))
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
function asConfigObject(
	path: string,
	parsed: unknown,
	label: string = shortHomePath(path),
): MutableConfig {
	if (parsed === null || parsed === undefined) return {}
	if (typeof parsed !== 'object' || Array.isArray(parsed)) {
		// Named the way the invalid-JSON sentence names it, and one sentence a
		// person can act on: the file, what is wrong, and what to do.
		throw new ConfigLoadError(
			path,
			`${label} must be a set of named settings, not ${describe(parsed)}. Fix it, then start Namzu again.`,
			{ complete: true },
		)
	}
	return sanitize(parsed, { kind: 'file', path })
}

function describe(value: unknown): string {
	return Array.isArray(value) ? 'a list' : `a ${typeof value}`
}

/** The text without one leading U+FEFF. */
export function stripByteOrderMark(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
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
type MutableConfig = {
	-readonly [K in keyof NamzuCliConfig]?: NamzuCliConfig[K]
}

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

const COMPOSER_TRIGGERS_KEYS: readonly string[] = ['enabled', 'suggest', 'languages', 'builtin']

const SKILLS_CONFIG_KEYS: readonly string[] = [
	'builtin',
	'disabled',
	'suggest',
	'suggestMinToolCalls',
]

/** The keys one `hooks` entry may carry. */
const HOOK_ENTRY_KEYS: readonly string[] = [
	'command',
	'matcher',
	'timeoutMs',
	'if',
	'once',
	'statusMessage',
]

const CONFIG_READERS: ConfigReaders = {
	format: (v, context) => {
		if (typeof v === 'string' && isFormatName(v)) return v
		return invalidConfigValue(context, [], 'must be one of "text", "json", or "yaml"')
	},
	quiet: (v, context) => {
		if (typeof v === 'boolean') return v
		return invalidConfigValue(context, [], 'must be a boolean')
	},
	modelCatalogueRefresh: (v, context) => {
		if (typeof v === 'boolean') return v
		return invalidConfigValue(context, [], 'must be a boolean')
	},
	hypermode: (v, context) => {
		if (typeof v === 'boolean') return v
		return invalidConfigValue(context, [], 'must be a boolean')
	},
	learningObservations: (v, context) => {
		if (typeof v === 'boolean') return v
		return invalidConfigValue(context, [], 'must be a boolean')
	},
	learningGenerator: (v, context) => {
		if (typeof v === 'boolean') return v
		if (!isConfigMapping(v))
			return invalidConfigValue(context, [], 'must be true, false or a mapping')
		const raw = v as Record<string, unknown>
		for (const key of Object.keys(raw)) {
			if (key !== 'enabled' && key !== 'cycleTokens' && key !== 'dailyTokens')
				return invalidConfigValue(
					context,
					[key],
					'is not a learningGenerator setting (enabled, cycleTokens, dailyTokens)',
				)
		}
		if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
			return invalidConfigValue(context, ['enabled'], 'must be a boolean')
		for (const key of ['cycleTokens', 'dailyTokens'] as const) {
			const value = raw[key]
			if (
				value !== undefined &&
				(typeof value !== 'number' ||
					!Number.isSafeInteger(value) ||
					value < MIN_LEARNING_TOKENS ||
					value > MAX_LEARNING_TOKENS)
			)
				return invalidConfigValue(
					context,
					[key],
					`must be a whole number from ${MIN_LEARNING_TOKENS} to ${MAX_LEARNING_TOKENS}`,
				)
		}
		return {
			...(raw.enabled !== undefined ? { enabled: raw.enabled as boolean } : {}),
			...(raw.cycleTokens !== undefined ? { cycleTokens: raw.cycleTokens as number } : {}),
			...(raw.dailyTokens !== undefined ? { dailyTokens: raw.dailyTokens as number } : {}),
		}
	},
	// Shape only. Per-entry validation belongs to `compilePermissions`, which
	// reports a bad effect or an unusable pattern as a diagnostic the user
	// sees; dropping those entries here would silence it.
	permissions: (v, context) => {
		if (!isConfigMapping(v)) {
			return invalidConfigValue(context, [], 'must be a mapping of tool names')
		}
		// The mode settings share the table with the tool rules, so they are
		// checked here, where a typo can still name its file and line.
		const problem = permissionSettingsProblem(v as Readonly<Record<string, unknown>>)
		if (problem) return invalidConfigValue(context, problem.path, problem.message)
		return v as PermissionsConfig
	},
	// Shape only, like `permissions` and for the same reason: per-entry
	// validation belongs to `verifyPermissionChecks`, which reports a bad
	// check by index. Dropping a malformed one here would turn "your check is
	// unreadable" into "your check passed".
	permissionChecks: (v, context) => {
		if (Array.isArray(v)) return v as PermissionChecksConfig
		return invalidConfigValue(context, [], 'must be a list')
	},
	// Derived from the layers' `permissions` tables while the cascade merges;
	// a file that wrote it would be claiming to be several layers at once.
	permissionLayers: (_v, context) =>
		invalidConfigValue(context, [], 'is worked out from the permissions tables; remove it'),
	// Lifted out of the same tables, so a file that wrote it would be claiming
	// an authority it does not have: set the keys inside `permissions` instead.
	permissionSettings: (_v, context) =>
		invalidConfigValue(
			context,
			[],
			'is worked out from the permissions table; set defaultMode, disableBypassMode, disableAutoMode or autoMode inside permissions',
		),
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
	memory: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		for (const key of Object.keys(v)) {
			if (key !== 'recall' && key !== 'identifierGrounding')
				return invalidConfigValue(context, [key], 'is not a memory key')
		}
		if (v.recall !== undefined && typeof v.recall !== 'boolean') {
			return invalidConfigValue(context, ['recall'], 'must be true or false')
		}
		if (v.identifierGrounding !== undefined && typeof v.identifierGrounding !== 'boolean') {
			return invalidConfigValue(context, ['identifierGrounding'], 'must be true or false')
		}
		return {
			...(v.recall === undefined ? {} : { recall: v.recall as boolean }),
			...(v.identifierGrounding === undefined
				? {}
				: { identifierGrounding: v.identifierGrounding as boolean }),
		}
	},
	compaction: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const raw = v as {
			strategy?: unknown
			recallEvidence?: unknown
			resolveEvidenceQueries?: unknown
			retainedToolPreviewChars?: unknown
			deduplicateObservations?: unknown
			contextWindowTokens?: unknown
			consolidate?: unknown
			idleCompaction?: unknown
			idleCompactionMinTokens?: unknown
			promptCacheTtl?: unknown
		}
		for (const key of Object.keys(v)) {
			if (
				key !== 'strategy' &&
				key !== 'contextWindowTokens' &&
				key !== 'consolidate' &&
				key !== 'recallEvidence' &&
				key !== 'resolveEvidenceQueries' &&
				key !== 'retainedToolPreviewChars' &&
				key !== 'deduplicateObservations' &&
				key !== 'idleCompaction' &&
				key !== 'idleCompactionMinTokens' &&
				key !== 'promptCacheTtl'
			) {
				return invalidConfigValue(context, [key], 'is not a compaction key')
			}
		}
		if (
			raw.deduplicateObservations !== undefined &&
			typeof raw.deduplicateObservations !== 'boolean'
		) {
			return invalidConfigValue(context, ['deduplicateObservations'], 'must be true or false')
		}
		if (raw.recallEvidence !== undefined && typeof raw.recallEvidence !== 'boolean')
			return invalidConfigValue(context, ['recallEvidence'], 'must be true or false')
		if (raw.resolveEvidenceQueries !== undefined && typeof raw.resolveEvidenceQueries !== 'boolean')
			return invalidConfigValue(context, ['resolveEvidenceQueries'], 'must be true or false')
		if (raw.consolidate !== undefined && typeof raw.consolidate !== 'boolean') {
			return invalidConfigValue(context, ['consolidate'], 'must be true or false')
		}
		if (raw.idleCompaction !== undefined && typeof raw.idleCompaction !== 'boolean') {
			return invalidConfigValue(context, ['idleCompaction'], 'must be true or false')
		}
		if (
			raw.idleCompactionMinTokens !== undefined &&
			(typeof raw.idleCompactionMinTokens !== 'number' ||
				!Number.isInteger(raw.idleCompactionMinTokens) ||
				raw.idleCompactionMinTokens <= 0)
		) {
			return invalidConfigValue(context, ['idleCompactionMinTokens'], 'must be a positive integer')
		}
		if (
			raw.promptCacheTtl !== undefined &&
			raw.promptCacheTtl !== '5m' &&
			raw.promptCacheTtl !== '1h'
		) {
			return invalidConfigValue(context, ['promptCacheTtl'], 'must be `5m` or `1h`')
		}
		if (
			raw.retainedToolPreviewChars !== undefined &&
			(typeof raw.retainedToolPreviewChars !== 'number' ||
				!Number.isSafeInteger(raw.retainedToolPreviewChars) ||
				raw.retainedToolPreviewChars < 0)
		) {
			return invalidConfigValue(
				context,
				['retainedToolPreviewChars'],
				'must be a nonnegative safe integer',
			)
		}
		if (
			raw.strategy !== undefined &&
			raw.strategy !== 'structured' &&
			raw.strategy !== 'salience'
		) {
			return invalidConfigValue(context, ['strategy'], 'must be `structured` or `salience`')
		}
		if (
			raw.contextWindowTokens !== undefined &&
			(typeof raw.contextWindowTokens !== 'number' ||
				!Number.isInteger(raw.contextWindowTokens) ||
				raw.contextWindowTokens <= 0)
		) {
			return invalidConfigValue(context, ['contextWindowTokens'], 'must be a positive integer')
		}
		return {
			...(raw.strategy !== undefined ? { strategy: raw.strategy } : {}),
			...(raw.contextWindowTokens !== undefined
				? { contextWindowTokens: raw.contextWindowTokens }
				: {}),
			...(raw.consolidate !== undefined ? { consolidate: raw.consolidate } : {}),
			...(raw.recallEvidence !== undefined ? { recallEvidence: raw.recallEvidence } : {}),
			...(raw.resolveEvidenceQueries !== undefined
				? { resolveEvidenceQueries: raw.resolveEvidenceQueries }
				: {}),
			...(raw.retainedToolPreviewChars !== undefined
				? { retainedToolPreviewChars: raw.retainedToolPreviewChars }
				: {}),
			...(raw.deduplicateObservations !== undefined
				? { deduplicateObservations: raw.deduplicateObservations }
				: {}),
			...(raw.idleCompaction !== undefined ? { idleCompaction: raw.idleCompaction } : {}),
			...(raw.idleCompactionMinTokens !== undefined
				? { idleCompactionMinTokens: raw.idleCompactionMinTokens }
				: {}),
			...(raw.promptCacheTtl !== undefined ? { promptCacheTtl: raw.promptCacheTtl } : {}),
		} as CompactionCliConfig
	},
	additionalDirectories: (v, context) => {
		if (!Array.isArray(v)) return invalidConfigValue(context, [], 'must be a list of directories')
		for (const [index, entry] of v.entries()) {
			if (typeof entry !== 'string' || entry.trim().length === 0) {
				return invalidConfigValue(context, [index], 'must be a directory path')
			}
		}
		return v as readonly string[]
	},
	toolResultScreens: (v, context) => {
		if (!Array.isArray(v)) {
			return invalidConfigValue(context, [], 'must be a list of screen names')
		}
		const names = TOOL_RESULT_SCREEN_NAMES.join(', ')
		for (const [index, entry] of v.entries()) {
			if (typeof entry === 'string') {
				if (!isToolResultScreenName(entry)) {
					return invalidConfigValue(context, [index], `must be one of: ${names}`)
				}
				continue
			}
			if (!isConfigMapping(entry)) {
				return invalidConfigValue(
					context,
					[index],
					'must be a screen name, or a mapping with a `name`',
				)
			}
			const { name, ...options } = entry
			if (typeof name !== 'string' || !isToolResultScreenName(name)) {
				return invalidConfigValue(context, [index, 'name'], `must be one of: ${names}`)
			}
			// An option the named screen does not read is refused rather than
			// carried: `{ "name": "injection", "passthroughTools": [...] }`
			// would otherwise install, parse, and exempt nothing, which reads
			// to an operator as the exemption being in force.
			for (const key of Object.keys(options)) {
				if (!TOOL_RESULT_SCREEN_OPTION_KEYS[name].includes(key)) {
					return invalidConfigValue(
						context,
						[index, key],
						`is not an option of the "${name}" screen`,
					)
				}
			}
			const passthroughTools = entry.passthroughTools
			if (passthroughTools === undefined) continue
			if (!Array.isArray(passthroughTools)) {
				return invalidConfigValue(
					context,
					[index, 'passthroughTools'],
					'must be a list of tool names',
				)
			}
			for (const [position, toolName] of passthroughTools.entries()) {
				if (typeof toolName !== 'string' || toolName.trim().length === 0) {
					return invalidConfigValue(
						context,
						[index, 'passthroughTools', position],
						'must be a tool name',
					)
				}
			}
		}
		return v as readonly ToolResultScreenConfig[]
	},
	hooks: (v, context) => {
		if (!isConfigMapping(v))
			return invalidConfigValue(context, [], 'must be a mapping of event → list')
		const events = new Set<string>(SHELL_HOOK_EVENTS)
		const out: Record<string, HookEntry[]> = {}
		for (const [event, entries] of Object.entries(v)) {
			const renamed = Object.hasOwn(RENAMED_PLUGIN_HOOK_EVENTS, event)
				? RENAMED_PLUGIN_HOOK_EVENTS[event]
				: undefined
			if (renamed !== undefined) {
				return invalidConfigValue(context, [event], `was renamed; name it \`${renamed}\``)
			}
			if (!events.has(event)) {
				return invalidConfigValue(
					context,
					[event],
					`is not a hook event (${SHELL_HOOK_EVENTS.join(', ')})`,
				)
			}
			if (!Array.isArray(entries))
				return invalidConfigValue(context, [event], 'must be a list of hooks')
			const parsed: HookEntry[] = []
			for (const [index, entry] of entries.entries()) {
				if (!isConfigMapping(entry)) {
					return invalidConfigValue(context, [event, index], 'must be a mapping with a `command`')
				}
				const raw = entry as {
					command?: unknown
					matcher?: unknown
					timeoutMs?: unknown
					if?: unknown
					once?: unknown
					statusMessage?: unknown
				}
				for (const key of Object.keys(entry)) {
					if (!HOOK_ENTRY_KEYS.includes(key)) {
						return invalidConfigValue(
							context,
							[event, index, key],
							'is not a recognized hook setting',
						)
					}
				}
				if (typeof raw.command !== 'string' || raw.command.trim().length === 0) {
					return invalidConfigValue(
						context,
						[event, index, 'command'],
						'must be a non-empty string',
					)
				}
				if (raw.matcher !== undefined && typeof raw.matcher !== 'string') {
					return invalidConfigValue(context, [event, index, 'matcher'], 'must be a string')
				}
				if (
					raw.timeoutMs !== undefined &&
					(typeof raw.timeoutMs !== 'number' ||
						!Number.isInteger(raw.timeoutMs) ||
						raw.timeoutMs <= 0)
				) {
					return invalidConfigValue(
						context,
						[event, index, 'timeoutMs'],
						'must be a positive integer',
					)
				}
				if (raw.if !== undefined && (typeof raw.if !== 'string' || raw.if.trim().length === 0)) {
					return invalidConfigValue(context, [event, index, 'if'], 'must be a non-empty string')
				}
				if (raw.once !== undefined && typeof raw.once !== 'boolean') {
					return invalidConfigValue(context, [event, index, 'once'], 'must be true or false')
				}
				if (
					raw.statusMessage !== undefined &&
					(typeof raw.statusMessage !== 'string' || raw.statusMessage.trim().length === 0)
				) {
					return invalidConfigValue(
						context,
						[event, index, 'statusMessage'],
						'must be a non-empty string',
					)
				}
				parsed.push({
					command: raw.command,
					...(raw.matcher !== undefined ? { matcher: raw.matcher } : {}),
					...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs } : {}),
					...(raw.if !== undefined ? { if: raw.if } : {}),
					...(raw.once !== undefined ? { once: raw.once } : {}),
					...(raw.statusMessage !== undefined ? { statusMessage: raw.statusMessage } : {}),
				})
			}
			out[event] = parsed
		}
		return out as HooksConfig
	},
	// Shape only; the interactive terminal is the one reader. A mapping with
	// a typo still refuses, because a line that silently never shows is worse.
	statusLine: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const raw = v as {
			type?: unknown
			command?: unknown
			padding?: unknown
			refreshInterval?: unknown
		}
		for (const key of Object.keys(v)) {
			if (!STATUS_LINE_KEYS.includes(key)) {
				return invalidConfigValue(
					context,
					[key],
					`is not a statusLine setting (${STATUS_LINE_KEYS.join(', ')})`,
				)
			}
		}
		if (raw.type !== undefined && raw.type !== 'command')
			return invalidConfigValue(context, ['type'], 'must be command')
		if (typeof raw.command !== 'string' || raw.command.trim().length === 0)
			return invalidConfigValue(context, ['command'], 'must be a non-empty string')
		if (
			raw.padding !== undefined &&
			(typeof raw.padding !== 'number' || !Number.isInteger(raw.padding) || raw.padding < 0)
		)
			return invalidConfigValue(context, ['padding'], 'must be a whole number, 0 or more')
		if (
			raw.refreshInterval !== undefined &&
			(typeof raw.refreshInterval !== 'number' ||
				!Number.isFinite(raw.refreshInterval) ||
				raw.refreshInterval < 1)
		)
			return invalidConfigValue(
				context,
				['refreshInterval'],
				'must be a number of seconds, 1 or more',
			)
		return {
			command: raw.command,
			...(raw.type !== undefined ? { type: 'command' as const } : {}),
			...(raw.padding !== undefined ? { padding: raw.padding } : {}),
			...(raw.refreshInterval !== undefined ? { refreshInterval: raw.refreshInterval } : {}),
		}
	},
	browser: (v, context) => readBrowserConfig(v, context),
	codeAnalysis: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		for (const key of Object.keys(v)) {
			if (key !== 'enabled') {
				return invalidConfigValue(context, [key], 'is not a codeAnalysis setting (enabled)')
			}
		}
		const raw = v as { enabled?: unknown }
		if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
			return invalidConfigValue(context, ['enabled'], 'must be true or false')
		return raw.enabled !== undefined ? { enabled: raw.enabled } : {}
	},
	web: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		for (const key of Object.keys(v)) {
			if (key !== 'fetch' && key !== 'search' && key !== 'backend')
				return invalidConfigValue(context, [key], 'is not a recognized web setting')
		}
		const raw = v as { fetch?: unknown; search?: unknown; backend?: unknown }
		if (
			raw.backend !== undefined &&
			raw.backend !== 'auto' &&
			raw.backend !== 'exa' &&
			raw.backend !== 'native'
		)
			return invalidConfigValue(context, ['backend'], 'must be auto, exa or native')
		if (raw.search === 'cached' && raw.backend === 'exa')
			return invalidConfigValue(context, ['backend'], 'cached search requires native')
		if (
			raw.search !== undefined &&
			(typeof raw.search !== 'string' || !['off', 'cached', 'live'].includes(raw.search))
		) {
			return invalidConfigValue(context, ['search'], 'must be off, cached, or live')
		}
		if (raw.fetch !== undefined && typeof raw.fetch !== 'boolean') {
			return invalidConfigValue(context, ['fetch'], 'must be a boolean')
		}
		return raw as WebConfig
	},
	limits: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		for (const key of Object.keys(v)) {
			if (!['maxIterations', 'tokenBudget', 'timeoutMs', 'waitForProviderMs'].includes(key))
				return invalidConfigValue(
					context,
					[key],
					'is not a limit (maxIterations, tokenBudget, timeoutMs, waitForProviderMs)',
				)
			const value = (v as Record<string, unknown>)[key]
			const minimum = key === 'waitForProviderMs' ? 1 : 0
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
				return invalidConfigValue(context, [key], `must be a safe whole number at least ${minimum}`)
			if (key === 'timeoutMs' && value > 2_147_483_647)
				return invalidConfigValue(
					context,
					[key],
					'must be at most 2147483647 milliseconds; use 0 for unlimited',
				)
		}
		return v as TurnLimitsConfig
	},
	workflow: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const caps = { maxConcurrency: 16, maxAgents: 1000 } as const
		for (const key of Object.keys(v)) {
			const value = (v as Record<string, unknown>)[key]
			if (key === 'sizeGuideline') {
				if (!isWorkflowSizeGuideline(value))
					return invalidConfigValue(
						context,
						[key],
						'must be one of unrestricted, small, medium or large',
					)
				continue
			}
			if (key !== 'maxConcurrency' && key !== 'maxAgents')
				return invalidConfigValue(
					context,
					[key],
					'is not a workflow setting (maxConcurrency, maxAgents, sizeGuideline)',
				)
			if (
				typeof value !== 'number' ||
				!Number.isSafeInteger(value) ||
				value < 1 ||
				value > caps[key]
			)
				return invalidConfigValue(context, [key], `must be a whole number from 1 to ${caps[key]}`)
		}
		return v as WorkflowCliConfig
	},
	plugins: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const known = new Set(['enabled', 'autoDiscovery', 'allowedScopes', 'hookTimeoutMs'])
		for (const key of Object.keys(v)) {
			if (!known.has(key)) {
				return invalidConfigValue(context, [key], 'is not a recognized plugin setting')
			}
		}
		const raw = v as {
			enabled?: unknown
			autoDiscovery?: unknown
			allowedScopes?: unknown
			hookTimeoutMs?: unknown
		}
		if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
			return invalidConfigValue(context, ['enabled'], 'must be a boolean')
		}
		if (raw.autoDiscovery !== undefined && typeof raw.autoDiscovery !== 'boolean') {
			return invalidConfigValue(context, ['autoDiscovery'], 'must be a boolean')
		}
		let allowedScopes: PluginConfig['allowedScopes']
		if (raw.allowedScopes !== undefined) {
			if (!Array.isArray(raw.allowedScopes)) {
				return invalidConfigValue(context, ['allowedScopes'], 'must be a list')
			}
			const invalidIndex = raw.allowedScopes.findIndex(
				(scope) => scope !== 'project' && scope !== 'user',
			)
			if (invalidIndex >= 0) {
				return invalidConfigValue(
					context,
					['allowedScopes', invalidIndex],
					'must be one of "project" or "user"',
				)
			}
			if (new Set(raw.allowedScopes).size !== raw.allowedScopes.length) {
				return invalidConfigValue(context, ['allowedScopes'], 'must not contain duplicates')
			}
			allowedScopes = raw.allowedScopes as readonly ('project' | 'user')[]
		}
		if (
			raw.hookTimeoutMs !== undefined &&
			(!Number.isInteger(raw.hookTimeoutMs) ||
				(raw.hookTimeoutMs as number) <= 0 ||
				(raw.hookTimeoutMs as number) > 2_147_483_647)
		) {
			return invalidConfigValue(
				context,
				['hookTimeoutMs'],
				'must be an integer from 1 to 2147483647',
			)
		}
		return {
			...(raw.enabled !== undefined ? { enabled: raw.enabled } : {}),
			...(raw.autoDiscovery !== undefined ? { autoDiscovery: raw.autoDiscovery } : {}),
			...(allowedScopes !== undefined ? { allowedScopes } : {}),
			...(raw.hookTimeoutMs !== undefined ? { hookTimeoutMs: raw.hookTimeoutMs as number } : {}),
		}
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
			allowEscape?: unknown
			allowUnattendedEscape?: unknown
			requireIsolation?: unknown
			workspace?: unknown
			teardownTimeoutMs?: unknown
		}
		for (const key of ['enabled', 'allowEscape', 'allowUnattendedEscape'] as const) {
			if (raw[key] !== undefined && typeof raw[key] !== 'boolean') {
				return invalidConfigValue(context, [key], 'must be a boolean')
			}
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
			raw.workspace !== undefined &&
			raw.workspace !== 'working-directory' &&
			raw.workspace !== 'ephemeral'
		) {
			return invalidConfigValue(
				context,
				['workspace'],
				'must be one of "working-directory" or "ephemeral"',
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
			...(raw.enabled !== undefined ? { enabled: raw.enabled as boolean } : {}),
			...(raw.allowEscape !== undefined ? { allowEscape: raw.allowEscape as boolean } : {}),
			...(raw.allowUnattendedEscape !== undefined
				? { allowUnattendedEscape: raw.allowUnattendedEscape as boolean }
				: {}),
			...(requireIsolation !== undefined
				? {
						requireIsolation: requireIsolation as readonly ('filesystem' | 'network' | 'process')[],
					}
				: {}),
			...(raw.workspace !== undefined
				? { workspace: raw.workspace as 'working-directory' | 'ephemeral' }
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
		const entry = se as {
			destination?: unknown
			eventTypes?: unknown
			redactors?: unknown
		}

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
	skills: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		for (const key of Object.keys(v)) {
			if (!SKILLS_CONFIG_KEYS.includes(key)) {
				return invalidConfigValue(
					context,
					[key],
					`is not a skills setting (${SKILLS_CONFIG_KEYS.join(', ')})`,
				)
			}
		}
		const raw = v as {
			builtin?: unknown
			disabled?: unknown
			suggest?: unknown
			suggestMinToolCalls?: unknown
		}
		if (raw.builtin !== undefined && typeof raw.builtin !== 'boolean') {
			return invalidConfigValue(context, ['builtin'], 'must be true or false')
		}
		if (raw.suggest !== undefined && typeof raw.suggest !== 'boolean') {
			return invalidConfigValue(context, ['suggest'], 'must be true or false')
		}
		if (
			raw.suggestMinToolCalls !== undefined &&
			(typeof raw.suggestMinToolCalls !== 'number' ||
				!Number.isInteger(raw.suggestMinToolCalls) ||
				raw.suggestMinToolCalls < 1)
		) {
			return invalidConfigValue(
				context,
				['suggestMinToolCalls'],
				'must be a whole number of at least 1',
			)
		}
		if (
			raw.disabled !== undefined &&
			(!Array.isArray(raw.disabled) ||
				raw.disabled.some((name) => typeof name !== 'string' || name.trim() === ''))
		) {
			return invalidConfigValue(context, ['disabled'], 'must be a list of skill names')
		}
		return {
			...(raw.builtin !== undefined ? { builtin: raw.builtin as boolean } : {}),
			...(raw.disabled !== undefined
				? { disabled: (raw.disabled as string[]).map((name) => name.trim()) }
				: {}),
			...(raw.suggest !== undefined ? { suggest: raw.suggest as boolean } : {}),
			...(raw.suggestMinToolCalls !== undefined
				? { suggestMinToolCalls: raw.suggestMinToolCalls as number }
				: {}),
		}
	},
	decision: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const raw = v as Record<string, unknown>
		const requireString = (key: string): string => {
			const value = raw[key]
			if (typeof value !== 'string' || value.length === 0) {
				return invalidConfigValue(context, [key], 'must be a non-empty string')
			}
			return value
		}
		const optionalString = (key: string): string | undefined => {
			if (raw[key] === undefined) return undefined
			return requireString(key)
		}
		const allow = (keys: readonly string[], provider: string): void => {
			for (const key of Object.keys(raw)) {
				if (!keys.includes(key)) {
					invalidConfigValue(
						context,
						[key],
						`is not a decision setting for provider "${provider}" (${keys.join(', ')})`,
					)
				}
			}
		}
		if (raw.provider === 'azure') {
			allow(['provider', 'endpoint', 'deployment', 'tokenEnv'], 'azure')
			const tokenEnv = optionalString('tokenEnv')
			return {
				provider: 'azure' as const,
				endpoint: requireString('endpoint'),
				deployment: requireString('deployment'),
				...(tokenEnv !== undefined ? { tokenEnv } : {}),
			}
		}
		if (raw.provider === 'http') {
			allow(['provider', 'url', 'model', 'apiKeyEnv'], 'http')
			const model = optionalString('model')
			const apiKeyEnv = optionalString('apiKeyEnv')
			return {
				provider: 'http' as const,
				url: requireString('url'),
				...(model !== undefined ? { model } : {}),
				...(apiKeyEnv !== undefined ? { apiKeyEnv } : {}),
			}
		}
		return invalidConfigValue(context, ['provider'], 'must be "azure" or "http"')
	},
	model: (v, context) => {
		if (v === 'auto') return 'auto' as const
		return invalidConfigValue(
			context,
			[],
			'must be "auto" (pin a specific model with --model or /model instead)',
		)
	},
	routing: (v, context) => readRoutingConfig(v, context),
	smallModel: (v, context) => {
		// One token: no whitespace and no control character, which no model id holds.
		const named = typeof v === 'string' ? v.trim() : ''
		if (named.length > 0 && [...named].every((char) => !/\s/u.test(char) && char >= ' '))
			return named
		return invalidConfigValue(
			context,
			[],
			'must be a model id, or "provider/model" (for example "anthropic/claude-haiku-4-5")',
		)
	},
	schedule: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		for (const key of Object.keys(v)) {
			if (key !== 'maxConcurrentRuns' && key !== 'notifications') {
				return invalidConfigValue(
					context,
					[key],
					'is not a schedule setting (maxConcurrentRuns, notifications)',
				)
			}
		}
		const raw = v as { maxConcurrentRuns?: unknown; notifications?: unknown }
		if (
			raw.maxConcurrentRuns !== undefined &&
			(typeof raw.maxConcurrentRuns !== 'number' ||
				!Number.isSafeInteger(raw.maxConcurrentRuns) ||
				raw.maxConcurrentRuns < 1 ||
				raw.maxConcurrentRuns > 16)
		) {
			return invalidConfigValue(
				context,
				['maxConcurrentRuns'],
				'must be a whole number from 1 to 16',
			)
		}
		if (raw.notifications !== undefined && typeof raw.notifications !== 'boolean') {
			return invalidConfigValue(context, ['notifications'], 'must be a boolean')
		}
		return {
			...(raw.maxConcurrentRuns !== undefined
				? { maxConcurrentRuns: raw.maxConcurrentRuns as number }
				: {}),
			...(raw.notifications !== undefined ? { notifications: raw.notifications as boolean } : {}),
		}
	},
	// Shape only: the words themselves are matched by the interactive
	// terminal, which is the only reader. A wrong key or value still refuses,
	// because an operator who wrote `enabled: flase` believes it is off.
	composerTriggers: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		for (const key of Object.keys(v)) {
			if (!COMPOSER_TRIGGERS_KEYS.includes(key)) {
				return invalidConfigValue(
					context,
					[key],
					`is not a composerTriggers setting (${COMPOSER_TRIGGERS_KEYS.join(', ')})`,
				)
			}
		}
		const raw = v as {
			enabled?: unknown
			suggest?: unknown
			languages?: unknown
			builtin?: unknown
		}
		for (const key of ['enabled', 'suggest'] as const) {
			if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
				return invalidConfigValue(context, [key], 'must be true or false')
		}
		let languages: ComposerTriggerLanguage[] | undefined
		if (raw.languages !== undefined) {
			if (!Array.isArray(raw.languages))
				return invalidConfigValue(context, ['languages'], 'must be a list: en, tr')
			languages = []
			for (const [index, language] of raw.languages.entries()) {
				if (!COMPOSER_TRIGGER_LANGUAGES.includes(language as ComposerTriggerLanguage))
					return invalidConfigValue(context, ['languages', index], 'must be en or tr')
				languages.push(language as ComposerTriggerLanguage)
			}
		}
		let builtin: Partial<Record<ComposerTriggerId, ComposerTriggerArming>> | undefined
		if (raw.builtin !== undefined) {
			if (!isConfigMapping(raw.builtin))
				return invalidConfigValue(
					context,
					['builtin'],
					'must be a mapping of trigger to arm, suggest or off',
				)
			builtin = {}
			for (const [id, arming] of Object.entries(raw.builtin)) {
				if (!COMPOSER_TRIGGER_IDS.includes(id as ComposerTriggerId))
					return invalidConfigValue(
						context,
						['builtin', id],
						`is not a built-in trigger (${COMPOSER_TRIGGER_IDS.join(', ')})`,
					)
				if (arming !== 'arm' && arming !== 'suggest' && arming !== 'off')
					return invalidConfigValue(context, ['builtin', id], 'must be arm, suggest or off')
				builtin[id as ComposerTriggerId] = arming
			}
		}
		return {
			...(raw.enabled !== undefined ? { enabled: raw.enabled as boolean } : {}),
			...(raw.suggest !== undefined ? { suggest: raw.suggest as boolean } : {}),
			...(languages !== undefined ? { languages } : {}),
			...(builtin !== undefined ? { builtin } : {}),
		}
	},
	tui: (v, context) => {
		if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
		const raw = v as {
			notifications?: unknown
			notificationMethod?: unknown
			theme?: unknown
			reducedMotion?: unknown
			recap?: unknown
			spinnerTips?: unknown
		}
		if (raw.spinnerTips !== undefined && typeof raw.spinnerTips !== 'boolean')
			return invalidConfigValue(context, ['spinnerTips'], 'must be a boolean')

		let notifications: boolean | readonly TerminalNotificationEvent[] | undefined
		if (typeof raw.notifications === 'boolean') notifications = raw.notifications
		else if (Array.isArray(raw.notifications)) {
			const invalidIndex = raw.notifications.findIndex(
				(event) =>
					event !== 'turn-settled' && event !== 'approval-required' && event !== 'idle-prompt',
			)
			if (invalidIndex >= 0) {
				return invalidConfigValue(
					context,
					['notifications', invalidIndex],
					'must be one of "turn-settled", "approval-required" or "idle-prompt"',
				)
			}
			notifications = raw.notifications as readonly TerminalNotificationEvent[]
		} else if (raw.notifications !== undefined) {
			return invalidConfigValue(context, ['notifications'], 'must be a boolean or a list')
		}

		const method = raw.notificationMethod
		if (
			method !== undefined &&
			method !== 'osc9' &&
			method !== 'bel' &&
			method !== 'kitty' &&
			method !== 'ghostty'
		) {
			return invalidConfigValue(
				context,
				['notificationMethod'],
				'must be "osc9", "bel", "kitty" or "ghostty"',
			)
		}

		const themeSetting = raw.theme === undefined ? undefined : parseThemeSetting(raw.theme)
		if (raw.theme !== undefined && themeSetting === undefined) {
			return invalidConfigValue(
				context,
				['theme'],
				`must be "auto" or one of ${THEME_NAMES.map((name) => `"${name}"`).join(', ')}`,
			)
		}
		if (raw.reducedMotion !== undefined && typeof raw.reducedMotion !== 'boolean') {
			return invalidConfigValue(context, ['reducedMotion'], 'must be true or false')
		}
		if (raw.recap !== undefined && typeof raw.recap !== 'boolean') {
			return invalidConfigValue(context, ['recap'], 'must be true or false')
		}

		return {
			...(notifications !== undefined ? { notifications } : {}),
			...(method !== undefined ? { notificationMethod: method } : {}),
			...(themeSetting !== undefined ? { theme: themeSetting } : {}),
			...(raw.reducedMotion !== undefined ? { reducedMotion: raw.reducedMotion } : {}),
			...(raw.recap !== undefined ? { recap: raw.recap } : {}),
			...(raw.spinnerTips !== undefined ? { spinnerTips: raw.spinnerTips } : {}),
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
	// Derived from the files' tables, never set from outside.
	permissionLayers: undefined,
	permissionSettings: undefined,
	// The SET of profiles is not env-settable — it is the thing being chosen
	// BETWEEN, and a variable that could replace it could hand a shell a
	// profile the files never declared. `NAMZU_PROFILE` selects one of the
	// declared profiles and is read in the cascade rather than here, because
	// it does not set a config field.
	profiles: undefined,
	mcpServers: undefined,
	// Executable code must never be enabled by ambient shell state. The file
	// and its provenance are the reviewable source of this authority.
	plugins: undefined,
	sandbox: undefined,
	limits: undefined,
	// The cost of a run is decided in the file, not by a variable in a shell profile.
	workflow: undefined,
	// Outbound reach is opted into in the file, never from the environment.
	web: undefined,
	// A browser signed in to the operator's sites, and which of them it may
	// change: a file decision, never a shell's.
	browser: undefined,
	// Reads project files into an index kept under the Namzu home; a file
	// decision, never a variable a shell profile could carry invisibly.
	codeAnalysis: undefined,
	// A hook runs a command with the operator's authority; the file is the only
	// place one may be declared.
	hooks: undefined,
	additionalDirectories: undefined,
	// Absent here for the reason `additionalDirectories` is: the environment
	// carries scalars, and a screen is a list of names whose meaning belongs
	// where a project's runs are reviewed.
	toolResultScreens: undefined,
	// A strategy is a property of a project's runs, declared where they are reviewed.
	compaction: undefined,
	memory: undefined,
	// Deliberately not env-settable. A `NAMZU_TELEMETRY_SESSION_EXPORT=/tmp/x`
	// in a shell profile would start exporting conversation content with
	// nothing in the config file to show for it — the disclosure would be
	// honest and the *reason* would be invisible.
	telemetry: undefined,
	// Terminal notifications are an interactive UI choice. An environment
	// variable in a shell profile must not start producing them invisibly.
	tui: undefined,
	// How many unattended runs a machine starts is the machine owner's to say,
	// in a file; never a variable a profile could carry invisibly.
	schedule: undefined,
	// Names an endpoint conversation context is sent to; a file declares it, never a shell profile.
	decision: undefined,
	// Chooses which provider and model receive the conversation; a file declares it.
	model: undefined,
	routing: undefined,
	// Chooses which model receives conversation text for side jobs; a file declares it.
	smallModel: undefined,
	// A list of names and a switch that decide what reaches the model's prompt;
	// declared in a file, where a project's runs are reviewed.
	skills: undefined,
	// What typed words do in the operator's own composer: a file decision,
	// never a variable a shell profile could carry invisibly.
	composerTriggers: undefined,
	// Runs a command with the operator's authority, like `hooks`: a file
	// decision, never a variable a shell profile could carry invisibly.
	statusLine: undefined,
	// Changes what the model is told on every turn; a file decision, never a variable a shell profile could carry invisibly.
	hypermode: undefined,
	// Only records locally and can only be a file decision, but keeps the rule that no variable carries it.
	learningObservations: undefined,
	// Spends tokens in the background and changes what conversations are told; a file decision.
	learningGenerator: undefined,
	// A scalar switch, and the one a CI job or a test harness needs to keep a
	// launch off the network without writing a config file.
	modelCatalogueRefresh: 'NAMZU_MODEL_CATALOGUE_REFRESH',
}

/** Which `NAMZU_*` variable actually set each field `readEnv` found. */
type EnvVariablesUsed = { -readonly [K in keyof NamzuCliConfig]?: string }

function readEnv(env: NodeJS.ProcessEnv): {
	config: MutableConfig
	variables: EnvVariablesUsed
} {
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

	const refreshVar = ENV_VARIABLE_NAMES.modelCatalogueRefresh
	if (refreshVar) {
		const refresh = env[refreshVar]
		if (refresh !== undefined) {
			if (refresh !== '1' && refresh !== 'true' && refresh !== '0' && refresh !== 'false') {
				throw new ConfigValueError(
					{ kind: 'environment', variable: refreshVar },
					'modelCatalogueRefresh',
					'must be one of "1", "true", "0", or "false"',
				)
			}
			config.modelCatalogueRefresh = refresh === '1' || refresh === 'true'
			variables.modelCatalogueRefresh = refreshVar
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
		if (!allowProfiles && (key === 'profiles' || key === 'plugins')) {
			throw new ConfigValueError(
				source,
				formatSettingPath([...prefix, key]),
				key === 'plugins'
					? 'cannot be declared inside a profile because profiles may be selected by the environment'
					: 'cannot be declared inside a profile',
			)
		}
		const parsed = CONFIG_READERS[key](v[key], {
			source,
			path: [...prefix, key],
		})
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

/**
 * Whose word a layer is, for the settings that stop the agent asking. The
 * user's file, the managed file and the environment are the operator's; the
 * project's two files are the workspace's, and so is a profile declared in one.
 */
function settingsAuthorityOf(source: ConfigSource): SettingsAuthority {
	switch (source.kind) {
		case 'project-file':
		case 'local-file':
			return 'workspace'
		case 'profile':
			return /(?:^|[\\/])namzu\.config(?:\.local)?\.json$/.test(source.path)
				? 'workspace'
				: 'operator'
		default:
			return 'operator'
	}
}

function describeSource(source: ConfigSource): string {
	return 'path' in source ? shortHomePath(source.path) : source.kind
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
	const permissionTables: PermissionsConfig[] = []
	for (const layer of layers) {
		for (const key of Object.keys(layer.config) as (keyof NamzuCliConfig)[]) {
			if (key === 'permissions' && layer.config.permissions) {
				// Joined, not replaced: a project's table must not erase a user's
				// deny, nor a managed table the rules below it. See
				// `compilePermissionLayers`.
				const source = layer.sourceFor(key)
				const split = splitPermissionsTable(
					layer.config.permissions,
					settingsAuthorityOf(source),
					describeSource(source),
				)
				permissionTables.push(split.rules)
				out.permissions = mergePermissionTables(permissionTables)
				out.permissionLayers = [...permissionTables]
				provenance[key] = source
				provenance.permissionLayers = source
				const settings = mergePermissionSettings(out.permissionSettings, split.settings)
				if (Object.keys(settings).length > 0) {
					out.permissionSettings = settings
					provenance.permissionSettings = source
				}
				continue
			}
			if (key === 'browser' && layer.config.browser) {
				// Merged, not replaced: see `mergeBrowserConfig`.
				out.browser = mergeBrowserConfig(out.browser, layer.config.browser, layer.sourceFor(key))
				provenance[key] = layer.sourceFor(key)
				continue
			}
			if (key === 'codeAnalysis' && layer.config.codeAnalysis) {
				// `enabled: false` holds: a later file may turn the tool off, never back on.
				out.codeAnalysis = mergeCodeAnalysisConfig(out.codeAnalysis, layer.config.codeAnalysis)
				provenance[key] = layer.sourceFor(key)
				continue
			}
			if (key === 'learningGenerator' && layer.config.learningGenerator !== undefined) {
				// A project layer only lowers. See `mergeLearningGenerator`.
				out.learningGenerator = mergeLearningGenerator(
					out.learningGenerator,
					layer.config.learningGenerator,
					isProjectSource(layer.sourceFor(key)),
				)
				provenance[key] = layer.sourceFor(key)
				continue
			}
			if (key === 'composerTriggers' && layer.config.composerTriggers) {
				// Merged per key; a project layer only lowers. See `mergeComposerTriggers`.
				out.composerTriggers = mergeComposerTriggers(
					out.composerTriggers,
					layer.config.composerTriggers,
					isProjectSource(layer.sourceFor(key)),
				)
				provenance[key] = layer.sourceFor(key)
				continue
			}
			if (key === 'tui' && layer.config.tui) {
				// Merged per key; the look of the terminal is the operator's, so a project layer cannot set it.
				out.tui = mergeTuiConfig(out.tui, layer.config.tui, isProjectSource(layer.sourceFor(key)))
				provenance[key] = layer.sourceFor(key)
				continue
			}
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

// ---------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------

const STATUS_LINE_KEYS: readonly string[] = ['type', 'command', 'padding', 'refreshInterval']

const ROUTING_KEYS: readonly string[] = ['default', 'tiers', 'strategy', 'thresholds', 'timeoutMs']

function readRoutingConfig(v: unknown, context: ConfigReaderContext): RoutingConfig {
	if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
	const raw = v as Record<string, unknown>
	for (const key of Object.keys(raw)) {
		if (!ROUTING_KEYS.includes(key)) {
			return invalidConfigValue(
				context,
				[key],
				`is not a routing setting (${ROUTING_KEYS.join(', ')})`,
			)
		}
	}
	const target = (value: unknown, path: readonly SettingPathSegment[]): RoutingTarget => {
		if (!isConfigMapping(value)) {
			return invalidConfigValue(context, path, 'must be a mapping with provider and model')
		}
		const entry = value as Record<string, unknown>
		for (const key of Object.keys(entry)) {
			if (key !== 'provider' && key !== 'model') {
				return invalidConfigValue(
					context,
					[...path, key],
					'is not a routing target setting (provider, model)',
				)
			}
		}
		for (const key of ['provider', 'model'] as const) {
			const field = entry[key]
			if (typeof field !== 'string' || field.trim() === '') {
				return invalidConfigValue(context, [...path, key], 'must be a non-empty string')
			}
		}
		return { provider: (entry.provider as string).trim(), model: (entry.model as string).trim() }
	}
	if (raw.default === undefined) {
		return invalidConfigValue(context, ['default'], 'is required: the model auto falls back to')
	}
	const defaultTarget = target(raw.default, ['default'])

	let tiers: RoutingConfig['tiers']
	if (raw.tiers !== undefined) {
		if (!isConfigMapping(raw.tiers))
			return invalidConfigValue(context, ['tiers'], 'must be a mapping')
		const tierRaw = raw.tiers as Record<string, unknown>
		for (const key of Object.keys(tierRaw)) {
			if (key !== 'fast' && key !== 'big') {
				return invalidConfigValue(
					context,
					['tiers', key],
					'is not a routing tier (fast, big); the default tier is routing.default',
				)
			}
		}
		tiers = {
			...(tierRaw.fast !== undefined ? { fast: target(tierRaw.fast, ['tiers', 'fast']) } : {}),
			...(tierRaw.big !== undefined ? { big: target(tierRaw.big, ['tiers', 'big']) } : {}),
		}
	}

	if (raw.strategy !== undefined && raw.strategy !== 'yesno' && raw.strategy !== 'score') {
		return invalidConfigValue(context, ['strategy'], 'must be "yesno" or "score"')
	}

	let thresholds: RoutingConfig['thresholds']
	if (raw.thresholds !== undefined) {
		if (!isConfigMapping(raw.thresholds)) {
			return invalidConfigValue(context, ['thresholds'], 'must be a mapping')
		}
		const thresholdRaw = raw.thresholds as Record<string, unknown>
		for (const key of Object.keys(thresholdRaw)) {
			if (key !== 'fast' && key !== 'big') {
				return invalidConfigValue(
					context,
					['thresholds', key],
					'is not a routing threshold (fast, big)',
				)
			}
			const value = thresholdRaw[key]
			if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
				return invalidConfigValue(
					context,
					['thresholds', key],
					'must be a number above 0 and at most 1',
				)
			}
		}
		thresholds = {
			...(thresholdRaw.fast !== undefined ? { fast: thresholdRaw.fast as number } : {}),
			...(thresholdRaw.big !== undefined ? { big: thresholdRaw.big as number } : {}),
		}
	}

	if (
		raw.timeoutMs !== undefined &&
		(typeof raw.timeoutMs !== 'number' ||
			!Number.isSafeInteger(raw.timeoutMs) ||
			raw.timeoutMs < 1 ||
			raw.timeoutMs > 10_000)
	) {
		return invalidConfigValue(context, ['timeoutMs'], 'must be a whole number from 1 to 10000')
	}

	return {
		default: defaultTarget,
		...(tiers ? { tiers } : {}),
		...(raw.strategy !== undefined ? { strategy: raw.strategy as 'yesno' | 'score' } : {}),
		...(thresholds ? { thresholds } : {}),
		...(raw.timeoutMs !== undefined ? { timeoutMs: raw.timeoutMs as number } : {}),
	}
}

// ---------------------------------------------------------------------------
// browser
// ---------------------------------------------------------------------------

const BROWSER_KEYS = new Set([
	'enabled',
	'defaultProfile',
	'engine',
	'headless',
	'sites',
	'keepOpen',
])
/** `@namzu/browser`'s profile names, restated so reading config does not load Playwright. */
const BROWSER_PROFILE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

function readBrowserConfig(v: unknown, context: ConfigReaderContext): BrowserConfig {
	if (!isConfigMapping(v)) return invalidConfigValue(context, [], 'must be a mapping')
	for (const key of Object.keys(v)) {
		if (!BROWSER_KEYS.has(key)) {
			return invalidConfigValue(
				context,
				[key],
				'is not a browser setting (enabled, defaultProfile, engine, headless, sites, keepOpen)',
			)
		}
	}
	const raw = v as Record<string, unknown>
	for (const key of ['enabled', 'keepOpen'] as const) {
		if (raw[key] !== undefined && typeof raw[key] !== 'boolean')
			return invalidConfigValue(context, [key], 'must be true or false')
	}
	if (
		raw.defaultProfile !== undefined &&
		(typeof raw.defaultProfile !== 'string' ||
			raw.defaultProfile.length > 64 ||
			!BROWSER_PROFILE_NAME.test(raw.defaultProfile))
	) {
		return invalidConfigValue(
			context,
			['defaultProfile'],
			'must be a profile name: lowercase letters, digits and single hyphens, at most 64 characters',
		)
	}
	if (raw.engine !== undefined && !['auto', 'windows', 'local'].includes(raw.engine as string))
		return invalidConfigValue(context, ['engine'], 'must be auto, windows or local')
	if (raw.headless !== undefined && !['auto', 'always', 'never'].includes(raw.headless as string))
		return invalidConfigValue(context, ['headless'], 'must be auto, always or never')
	let sites: Record<string, BrowserSiteLevel> | undefined
	if (raw.sites !== undefined) {
		if (!isConfigMapping(raw.sites))
			return invalidConfigValue(context, ['sites'], 'must be a mapping of site to level')
		sites = {}
		for (const [key, level] of Object.entries(raw.sites)) {
			// Refused, not dropped: a site rule that silently vanished is a deny
			// the operator believes in and the gate never sees.
			if (!isBrowserSiteLevel(level))
				return invalidConfigValue(context, ['sites', key], 'must be deny, read, ask or act')
			const verdict = canonicalBrowserSiteKey(key)
			if (!verdict.ok) return invalidConfigValue(context, ['sites', key], verdict.reason)
			const existing = sites[verdict.key]
			sites[verdict.key] = existing === undefined ? level : narrower(existing, level)
		}
	}
	return {
		...(raw.enabled !== undefined ? { enabled: raw.enabled as boolean } : {}),
		...(raw.defaultProfile !== undefined ? { defaultProfile: raw.defaultProfile as string } : {}),
		...(raw.engine !== undefined ? { engine: raw.engine as BrowserConfig['engine'] } : {}),
		...(raw.headless !== undefined ? { headless: raw.headless as BrowserConfig['headless'] } : {}),
		...(sites !== undefined ? { sites } : {}),
		...(raw.keepOpen !== undefined ? { keepOpen: raw.keepOpen as boolean } : {}),
	}
}

/** `codeAnalysis` from one more layer: off in any file stays off. */
export function mergeCodeAnalysisConfig(
	below: CodeAnalysisConfig | undefined,
	layer: CodeAnalysisConfig,
): CodeAnalysisConfig {
	if (!below) return layer
	const enabled =
		below.enabled === false || layer.enabled === false ? false : (layer.enabled ?? below.enabled)
	return enabled !== undefined ? { enabled } : {}
}

/**
 * `tui` from one more layer: later keys win. `theme` and `reducedMotion` are the
 * operator's own taste, so a project layer's values for them are dropped.
 */
export function mergeTuiConfig(
	below: TuiConfig | undefined,
	layer: TuiConfig,
	fromProject: boolean,
): TuiConfig {
	const { theme: _theme, reducedMotion: _motion, ...rest } = layer
	return { ...below, ...(fromProject ? rest : layer) }
}

function isProjectSource(source: ConfigSource): boolean {
	return (
		source.kind === 'project-file' ||
		source.kind === 'local-file' ||
		(source.kind === 'profile' &&
			(basename(source.path) === 'namzu.config.json' ||
				basename(source.path) === LOCAL_CONFIG_FILE))
	)
}

/**
 * `browser` from one more layer, over what the layers below it said.
 *
 * Merged key by key, the later layer winning, with three exceptions, all in
 * the direction of less reach:
 *
 * - `enabled: false` in any file holds; a later file cannot switch it on.
 * - `sites` are merged per site. A site any file denies stays denied, and
 *   once a file has denied every other site (`"*": deny`), a later file's
 *   new sites are ignored: they would open what that file closed.
 * - `defaultProfile` is refused in a project file. A profile carries the
 *   operator's sign-ins, and a repository must not pick which ones its
 *   agent runs under.
 */
export function mergeBrowserConfig(
	below: BrowserConfig | undefined,
	layer: BrowserConfig,
	source: ConfigSource,
): BrowserConfig {
	if (layer.defaultProfile !== undefined && isProjectSource(source)) {
		throw new ConfigValueError(
			{ kind: 'file', path: 'path' in source ? source.path : 'namzu.config.json' },
			'browser.defaultProfile',
			'cannot be set in a project file: a profile holds your sign-ins, so choose it in your user config or with /browser profile',
		)
	}
	if (!below) return layer
	let sites = below.sites
	if (layer.sites) {
		const merged: Record<string, BrowserSiteLevel> = { ...(below.sites ?? {}) }
		const closed = below.sites?.['*'] === 'deny'
		for (const [key, level] of Object.entries(layer.sites)) {
			const existing = merged[key]
			if (existing === undefined) {
				if (closed && key !== '*') continue
				merged[key] = level
				continue
			}
			merged[key] = existing === 'deny' ? 'deny' : level
		}
		sites = merged
	}
	const enabled =
		below.enabled === false || layer.enabled === false ? false : (layer.enabled ?? below.enabled)
	return {
		...below,
		...layer,
		...(enabled !== undefined ? { enabled } : {}),
		...(sites !== undefined ? { sites } : {}),
	}
}
