/**
 * Public @namzu/cli configuration vocabulary.
 *
 * Runtime admission lives in `load.ts`, beside the source/precedence facts it
 * needs for actionable errors. Keeping this file declarative makes the public
 * type the one list of settings while the loader's total reader map forces a
 * validation decision whenever that list grows.
 */

import type { McpServersConfig } from '../integrations/mcp/servers.js'
import type { FormatName } from '../output/index.js'
import type { PermissionChecksConfig } from '../permissions/checks.js'
import type { PermissionsConfig } from '../permissions/rules.js'

/**
 * What one profile may set.
 *
 * Executable plugins are intentionally excluded as well as nested profiles:
 * `NAMZU_PROFILE` may select a declared profile, and ambient shell state must
 * not be able to turn code loading on.
 */
export type ProfileConfig = Omit<NamzuCliConfig, 'profiles' | 'plugins'>

export type ProfilesConfig = Readonly<Record<string, ProfileConfig>>

/** The two operator-visible moments the TUI can notify about. */
export type TerminalNotificationEvent = 'turn-settled' | 'approval-required'

/** Escape protocol used for an opted-in terminal notification. */
export type TerminalNotificationMethod = 'osc9' | 'bel'

export interface TuiConfig {
	/**
	 * Notify for TUI events through the terminal itself.
	 *
	 * Absent or `false` means off. `true` enables both events; a list enables
	 * only the named events, and an empty list explicitly disables all of them.
	 * No command is started and no conversation content is included.
	 */
	readonly notifications?: boolean | readonly TerminalNotificationEvent[]
	/** Terminal protocol to write. Defaults to `osc9` when notifications are on. */
	readonly notificationMethod?: TerminalNotificationMethod
}

/** Where the CLI may discover executable plugin bundles. */
export type PluginScope = 'project' | 'user'

/**
 * Session plugin runtime settings.
 *
 * Plugins may import JavaScript hooks and tools, so the runtime is disabled
 * unless an operator opts in explicitly. Project plugins are considered only
 * after the existing project trust gate has pinned the canonical cwd.
 */
export interface PluginConfig {
	/** Start the plugin runtime. Only the exact value `true` enables it. */
	readonly enabled?: boolean
	/** Scan admitted plugin directories. Defaults to `true` once enabled. */
	readonly autoDiscovery?: boolean
	/** Locations the discovery pass may read. Defaults to project and user. */
	readonly allowedScopes?: readonly PluginScope[]
	/** Per-hook deadline in milliseconds. Defaults to the SDK runtime default. */
	readonly hookTimeoutMs?: number
}

export interface NamzuCliConfig {
	/** Default output format when not overridden by --format. */
	readonly format?: FormatName
	/** Default quiet mode. */
	readonly quiet?: boolean
	/**
	 * Which tools may run without asking, keyed by tool name.
	 *
	 * A value is `"allow" | "ask" | "deny"`, or a table of argument patterns
	 * mapping to those. Absent means every mutating tool prompts, which is what
	 * it meant before this existed — the absence of a policy never widens one.
	 */
	readonly permissions?: PermissionsConfig
	/**
	 * What the operator believes the table above decides, checked at startup.
	 *
	 * Each entry names a tool, an input, and the expected `"allow" | "ask" |
	 * "deny"`. A mismatch is reported by index and the run continues — the
	 * point is to say that a policy does not do what its author said, which
	 * a table of globs cannot be read for. Absent means nothing is checked,
	 * which is what it meant before this existed.
	 */
	readonly permissionChecks?: PermissionChecksConfig
	/**
	 * Named bundles of settings to switch between.
	 *
	 * A profile is not another file. It sits INSIDE one, so the settings a
	 * person switches between live next to each other and can be read as a
	 * set — which is the thing a second config file cannot give you, because
	 * a second file has to be found before it can be compared.
	 *
	 * Selecting one applies it as a layer above the file it came from, so a
	 * profile overrides that file's own base values and is in turn overridden
	 * by the environment. A profile may set anything except `profiles` and
	 * executable `plugins`: a
	 * profile that carried profiles would be a cascade inside a cascade, and
	 * the question "which one is active" would stop having one answer.
	 * Plugins are excluded because `NAMZU_PROFILE` can select a profile; shell
	 * state must not be an executable-code authority.
	 */
	readonly profiles?: ProfilesConfig
	/**
	 * External tool servers to connect, keyed by the name their tools are
	 * prefixed with.
	 *
	 * Each entry names either a `command` to run or a `url` to reach. Absent
	 * means no external servers, which is what it meant before this existed.
	 */
	readonly mcpServers?: McpServersConfig
	/** Executable extension bundles. Absent keeps discovery and imports off. */
	readonly plugins?: PluginConfig
	/**
	 * Isolation for the commands this CLI runs.
	 *
	 * Absent means ON. That is a change from every version before this one,
	 * where `sandboxProvider` appeared nowhere in this package and every
	 * tool call ran in the host process with the host environment — the
	 * isolation the documentation described held on no path at all.
	 *
	 * Named `sandbox` rather than `isolation` because the thing being
	 * configured is the sandbox; what it enforces is `requireIsolation`
	 * inside it, and collapsing the two would make "turn isolation off"
	 * ambiguous between "no sandbox" and "a sandbox that requires nothing".
	 */
	readonly sandbox?: SandboxConfig
	/**
	 * Observability this CLI turns on for itself.
	 *
	 * Absent means none, which is what it meant before this existed —
	 * `sessionExport` in particular sends conversation content off the
	 * machine, so it is a thing an operator asks for by name and never
	 * something a default arranges.
	 */
	readonly telemetry?: TelemetryConfig
	/** Interactive-terminal-only behaviour. Absent leaves notifications off. */
	readonly tui?: TuiConfig
}

export interface TelemetryConfig {
	/**
	 * Write this session's run events somewhere.
	 *
	 * The disclosure `@namzu/telemetry`'s `describeSessionExport` builds
	 * from this is printed at boot, because the operator configuring it and
	 * the person whose conversation leaves the machine are frequently not
	 * the same person.
	 */
	readonly sessionExport?: SessionExportConfig
}

export interface SessionExportConfig {
	/**
	 * Absolute or cwd-relative path to a JSONL file, one record per line.
	 *
	 * A file, not a URL, and that is a limit rather than an oversight: a
	 * network destination needs retry, backpressure and a credential, and
	 * a CLI that shipped a half-built one would be offering an export that
	 * silently drops. A host that needs a collector builds a
	 * `SessionExportSink` and attaches the listener itself — that seam is
	 * the package's public surface.
	 */
	readonly destination: string
	/**
	 * Which run event types to export. Absent means all of them.
	 *
	 * Not validated against the event union here: a name that matches no
	 * event exports nothing under it, and the boot disclosure prints the
	 * list verbatim, so a typo is visible rather than silently widening.
	 */
	readonly eventTypes?: readonly string[]
	/**
	 * Redactors to install, in order. `secrets` is the shipped one.
	 *
	 * An empty array means NO redaction, and it is spelled that way on
	 * purpose: omitting the key installs the default, so a config has to
	 * say `[]` to turn redaction off rather than reach it by forgetting.
	 */
	readonly redactors?: readonly SessionExportRedactorName[]
}

/** The redactors this CLI can install by name. */
export type SessionExportRedactorName = 'secrets'

export interface SandboxConfig {
	/**
	 * Run commands inside a sandbox. Default `true`.
	 *
	 * Setting it to `false` is a real choice with a real reason — a host
	 * that provides its own isolation, or a platform where the sandbox
	 * cannot start — and it is announced on startup rather than assumed.
	 * It is not a way to make a failing sandbox quiet.
	 */
	readonly enabled?: boolean
	/**
	 * Controls this machine must actually enforce, or the CLI refuses to
	 * start.
	 *
	 * Empty by default, and the default is honest rather than safe: the
	 * available isolation differs per platform, so requiring anything by
	 * default would refuse to run on machines where the CLI works today.
	 * What the sandbox does and does not confine is reported on startup
	 * either way — an operator who needs a guarantee names it here and gets
	 * a refusal instead of a surprise.
	 */
	readonly requireIsolation?: readonly ('filesystem' | 'network' | 'process')[]
	/**
	 * How long a completed or cancelled run waits for sandbox teardown.
	 * Defaults to 30 seconds. Set to `0` to preserve the former unbounded wait.
	 */
	readonly teardownTimeoutMs?: number
}

export const DEFAULT_CONFIG: NamzuCliConfig = Object.freeze({
	format: 'text',
	quiet: false,
})
