/**
 * @namzu/cli config schema (M0 stub).
 *
 * The schema is intentionally minimal in M0; each later milestone extends
 * it as concrete settings land (M2 providers, M4 memory, M5 skills, etc.).
 * Validation library (e.g. Zod) is introduced when constraints exist that
 * are worth enforcing at runtime — premature now.
 */

import type { FormatName } from '../output/index.js'

export interface NamzuCliConfig {
	/** Default output format when not overridden by --format. */
	readonly format?: FormatName
	/** Default quiet mode. */
	readonly quiet?: boolean
}

export const DEFAULT_CONFIG: NamzuCliConfig = Object.freeze({
	format: 'text',
	quiet: false,
})
