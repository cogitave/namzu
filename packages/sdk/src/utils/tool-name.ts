import { TOOL_NAME_MAX_LENGTH } from '../constants/tools/index.js'

/** Length of the deterministic suffix appended whenever a name has to be repaired. */
const HASH_LENGTH = 7

/** Longest base kept ahead of the suffix: 56 + `_` + 7 = 64. */
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
 * A name that needs no repair: already `[a-zA-Z0-9_-]{1,64}`, and free of the
 * `__` plugin namespace separator. Such a name is passed through unchanged, so
 * the common case (`read_file`, `search-docs`) is untouched and readable.
 */
function isAlreadyCanonical(value: string): boolean {
	return (
		value.length > 0 &&
		value.length <= TOOL_NAME_MAX_LENGTH &&
		/^[a-zA-Z0-9_-]+$/.test(value) &&
		!value.includes('__')
	)
}

/**
 * Map an arbitrary string onto a name a provider will accept — `[a-zA-Z0-9_-]`,
 * 1 to 64 characters — without ever throwing, and **without losing the
 * distinction between two different remote names**.
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
 * **Repair implies a hash suffix.** Sanitizing alone is lossy: `a.b`, `a/b`,
 * `a__b` and `a_b` all sanitize to `a_b`, so two different remote tools would
 * claim one registry key and whichever registered first would win. Registration
 * order across MCP servers is not stable across restarts, so a canonical name
 * persisted in a run history could come back pointing at a DIFFERENT remote tool
 * (ses_015 pre-freeze B3). Therefore: if the sanitized form differs from the raw
 * input in ANY way — a character replaced, a `__` collapsed, a truncation — the
 * result is `<sanitized-base>_<hash7>` where the hash is taken over the ORIGINAL
 * raw string. Distinct raw names therefore yield distinct canonical names, and
 * the mapping is a pure function of the raw name alone: identical in every
 * process, every release, and independent of the order tools were registered in.
 *
 * `__` never survives: it is the plugin namespace separator, and a canonicalized
 * name containing one would be indistinguishable from a composed `plugin__tool`
 * and would break the injectivity the namespace depends on. The suffix joins on a
 * base whose trailing underscores are stripped, so the join cannot introduce one
 * either.
 *
 * The 32-bit hash makes an aliasing collision astronomically unlikely rather than
 * impossible; it is not the last line of defence. A canonical name that is
 * already taken is skipped and reported (`plugin_tool_skipped`), never silently
 * aliased onto the tool that got there first.
 *
 * The remote name is never what gets invoked — the adapters capture it in the
 * tool's `execute` closure — so renaming the registry key is invisible to the
 * server on the other end.
 */
export function canonicalizeToolName(raw: string): string {
	if (isAlreadyCanonical(raw)) return raw

	const substituted = raw.replace(/[^a-zA-Z0-9_-]+/g, '_')
	const collapsed = substituted.replace(/_{2,}/g, '_')

	// Trailing underscores are stripped before the suffix joins on, so the join
	// cannot itself introduce a `__`.
	const prefix = collapsed.slice(0, TRUNCATED_PREFIX_LENGTH).replace(/_+$/, '')
	const head = prefix.length > 0 ? prefix : 'tool'
	return `${head}_${stableHash(raw)}`
}
