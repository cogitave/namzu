/**
 * @namzu/cli config schema (M0 stub).
 *
 * The schema is intentionally minimal in M0; each later milestone extends
 * it as concrete settings land (M2 providers, M4 memory, M5 skills, etc.).
 * Validation library (e.g. Zod) is introduced when constraints exist that
 * are worth enforcing at runtime — premature now.
 */

import type { FormatName } from '../output/index.js'
import type { PermissionsConfig } from '../permissions/rules.js'

export interface ClawtoolConfig {
	/** Absolute path to the clawtool binary; overrides PATH lookup. */
	readonly binary?: string
	/** HTTP base URL (e.g. http://127.0.0.1:8765); overrides daemon-state discovery. */
	readonly endpoint?: string
	/** Override the bearer token (raw, no `Bearer ` prefix). */
	readonly token?: string
	/** Spawn the daemon automatically if not running. Defaults to true. */
	readonly autoStart?: boolean
}

export interface NamzuCliConfig {
	/** Default output format when not overridden by --format. */
	readonly format?: FormatName
	/** Default quiet mode. */
	readonly quiet?: boolean
	/** Clawtool integration overrides; defaults work zero-config. */
	readonly clawtool?: ClawtoolConfig
	/**
	 * Which tools may run without asking, keyed by tool name.
	 *
	 * A value is `"allow" | "ask" | "deny"`, or a table of argument patterns
	 * mapping to those. Absent means every mutating tool prompts, which is what
	 * it meant before this existed — the absence of a policy never widens one.
	 */
	readonly permissions?: PermissionsConfig
}

export const DEFAULT_CONFIG: NamzuCliConfig = Object.freeze({
	format: 'text',
	quiet: false,
})
