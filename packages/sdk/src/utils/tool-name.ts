import { TOOL_NAME_MAX_LENGTH } from '../constants/tools/index.js'

/** Length of the deterministic suffix appended when a name has to be shortened. */
const HASH_LENGTH = 7

/** Longest prefix kept when truncating: 56 + `_` + 7 = 64. */
const TRUNCATED_PREFIX_LENGTH = TOOL_NAME_MAX_LENGTH - HASH_LENGTH - 1

/**
 * FNV-1a (32-bit), rendered base36 and zero-padded to a fixed width.
 *
 * Implemented here rather than taken from a dependency: the only requirement is
 * that one input yields one suffix in every process and every release, so that a
 * canonicalized name persisted in a run history still resolves after a restart.
 */
function stableHash(value: string): string {
	let hash = 0x811c9dc5
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i)
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash.toString(36).padStart(HASH_LENGTH, '0').slice(0, HASH_LENGTH)
}

/**
 * Map an arbitrary string onto a name a provider will accept — `[a-zA-Z0-9_-]`,
 * 1 to 64 characters — without ever throwing.
 *
 * This exists for names we do not author. An MCP server or a connector
 * advertises whatever it likes (`notion.search`, `db:query`, a 70-character
 * method name), and an operator cannot rename a tool that lives inside someone
 * else's server, so a nonconforming remote name must be repaired rather than
 * rejected: a single one of them used to fail the registration and abort the
 * whole plugin enable. Names we DO author — a plugin's own name, its own tools,
 * the MCP server aliases its manifest chooses — keep the strict validation in
 * {@link assertNameComponent}, because their author can fix them.
 *
 * `__` collapses to `_`, because the double underscore is the plugin namespace
 * separator: a canonicalized name that kept one would be indistinguishable from
 * a composed `plugin__tool` and would break the injectivity the namespace
 * depends on.
 *
 * The remote name is never what gets invoked — the adapters capture it in the
 * tool's `execute` closure — so renaming the registry key is invisible to the
 * server on the other end.
 */
export function canonicalizeToolName(raw: string): string {
	const substituted = raw.replace(/[^a-zA-Z0-9_-]+/g, '_')
	const collapsed = substituted.replace(/_{2,}/g, '_')
	const base = collapsed.length > 0 ? collapsed : `tool_${stableHash(raw)}`

	if (base.length <= TOOL_NAME_MAX_LENGTH) return base

	// The truncated prefix is stripped of trailing underscores before the suffix
	// joins on, so shortening cannot itself introduce a `__`.
	const prefix = base.slice(0, TRUNCATED_PREFIX_LENGTH).replace(/_+$/, '')
	const head = prefix.length > 0 ? prefix : 'tool'
	return `${head}_${stableHash(raw)}`
}
