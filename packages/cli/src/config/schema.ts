/**
 * @namzu/cli config schema (M0 stub).
 *
 * The schema is intentionally minimal in M0; each later milestone extends
 * it as concrete settings land (M2 providers, M4 memory, M5 skills, etc.).
 * Validation library (e.g. Zod) is introduced when constraints exist that
 * are worth enforcing at runtime — premature now.
 */

import type { McpServersConfig } from '../integrations/mcp/servers.js'
import type { FormatName } from '../output/index.js'
import type { PermissionsConfig } from '../permissions/rules.js'

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
	 * External tool servers to connect, keyed by the name their tools are
	 * prefixed with.
	 *
	 * Each entry names either a `command` to run or a `url` to reach. Absent
	 * means no external servers, which is what it meant before this existed.
	 */
	readonly mcpServers?: McpServersConfig
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
}

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
}

export const DEFAULT_CONFIG: NamzuCliConfig = Object.freeze({
	format: 'text',
	quiet: false,
})
