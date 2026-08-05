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
}

export const DEFAULT_CONFIG: NamzuCliConfig = Object.freeze({
	format: 'text',
	quiet: false,
})
