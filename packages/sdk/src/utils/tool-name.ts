import { TOOL_NAME_MAX_LENGTH } from '../constants/tools/index.js'

/** Length of the deterministic suffix appended whenever a name has to be repaired. */
const HASH_LENGTH = 7

/** `_` plus the hash: what a repair costs on top of whatever base survives. */
const SUFFIX_LENGTH = HASH_LENGTH + 1

/** Shortest repaired name there is: one base character, then the suffix. */
const MIN_REPAIRED_LENGTH = SUFFIX_LENGTH + 1

/**
 * The exact shape a repair produces — and therefore a shape a RAW name is not
 * allowed to keep: `_`, then seven base36 digits of which the first is `0` or `1`.
 *
 * The leading `[01]` is arithmetic, not convention. The hash is a 32-bit integer
 * and `36^6 < 2^32 < 36^7`, so its base36 rendering is at most seven digits and,
 * zero-padded to seven, always opens with `0` or `1`. Pinning that down is what
 * keeps the reserved shape narrow enough to be harmless: `send_message` and
 * `get_weather` do not wear it (`m`, `w`), so they still pass through untouched,
 * while `tool_04la3gs` does and is repaired.
 */
const RESERVED_SUFFIX_PATTERN = /_[01][0-9a-z]{6}$/

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
 * A name that needs no repair: already `[a-zA-Z0-9_-]`, within budget, and free
 * of the `__` plugin namespace separator.
 */
function needsNoSubstitution(value: string, maxLength: number): boolean {
	return (
		value.length > 0 &&
		value.length <= maxLength &&
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
 * ## The two spaces are disjoint
 *
 * The function has exactly two outcomes, and nothing can land in both:
 *
 *   - **Identity.** The raw name is already valid, fits `maxLength`, carries no
 *     `__`, and does not wear the reserved suffix shape. It is returned as-is, so
 *     `read_file` stays `read_file` and the common case is readable.
 *   - **Repair.** Anything else — a substituted character, a collapsed `__`, a
 *     truncation, OR a name that is valid but wears the reserved shape — becomes
 *     `<base>_<hash7>`, where the hash is taken over the ORIGINAL raw string.
 *
 * Repair alone is not enough for injectivity, and that was the ses_015 pre-freeze
 * B3 hole. Sanitizing is lossy (`a.b`, `a/b`, `a__b` and `a_b` all sanitize to
 * `a_b`), so the hash was added — but a repaired name is itself a legal name, so
 * a server that advertised the literal string `a_b_04la3gs` took the identity path
 * and landed exactly on top of `canonicalizeToolName('a.b')`. The hashed space and
 * the identity space overlapped, and the lifecycle kept whichever tool it saw
 * first. **Reserving the suffix shape closes that**: a raw name wearing it is
 * pushed into the repaired space too, so the identity space contains no
 * reserved-shaped name and the repaired space contains nothing but reserved-shaped
 * names. Two distinct raw names can now collide only on a genuine 32-bit hash
 * collision — never through aliasing, and never through arrival order.
 *
 * `__` never survives: it is the plugin namespace separator, and a canonicalized
 * name containing one would be indistinguishable from a composed `plugin__tool`
 * and would break the injectivity the namespace depends on. The suffix joins on a
 * base whose trailing underscores are stripped, so the join cannot introduce one
 * either.
 *
 * ## Apply exactly once, at the ingest boundary
 *
 * **This function is deliberately NOT idempotent, and must never be applied to
 * its own output.** Reserving the suffix shape is what makes the two spaces
 * disjoint, so a repaired name — which wears that shape by construction — is
 * itself an input the function must repair: `canonicalizeToolName('a.b')` is
 * `a_b_04la3gs`, and feeding that back yields `a_b_04la3gs_0665qjo`. Idempotence
 * and injectivity cannot both hold here; injectivity is the one that keeps a
 * persisted name pointing at the tool it was persisted for, so it wins.
 *
 * The contract is therefore positional, not defensive: canonicalize a remote name
 * ONCE, where it enters the SDK (the MCP/connector adapters and the plugin
 * lifecycle's leaf pass), and treat the result as the name from then on. A resume
 * or replay path that re-canonicalizes a name it read back from a run history
 * would mint a NEW name and silently fail to resolve the tool. There is no guard
 * against double application, and there cannot be one: an "already canonical?"
 * check would have to recognise the reserved shape and pass it through untouched,
 * which is precisely the identity-space overlap that reopens the collision hole
 * (ses_015 pre-freeze B3/H2).
 *
 * ## Budget
 *
 * `maxLength` is the space this name actually has, which is not always the
 * standalone 64: a plugin's MCP leaf is composed into `plugin__server__leaf`, so
 * its real budget is `64 - (plugin + 2 + server + 2)` and the caller passes that.
 * Budgeting the hash suffix against 64 instead made a leaf that used to fit
 * compose past the limit and quietly disappear.
 *
 * The result fits `maxLength` whenever that is arithmetically possible, i.e.
 * whenever `maxLength >= {@link MIN_REPAIRED_LENGTH}` (9). Below that no repaired
 * name exists at all; the minimal one is returned, it is longer than the budget,
 * and the caller's own length check is what rejects it — canonicalization itself
 * still never throws, because a throw here would take the whole plugin enable
 * down with a tool nobody on this side can rename.
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
export function canonicalizeToolName(
	raw: string,
	maxLength: number = TOOL_NAME_MAX_LENGTH,
): string {
	const budget = Math.min(maxLength, TOOL_NAME_MAX_LENGTH)

	if (needsNoSubstitution(raw, budget) && !RESERVED_SUFFIX_PATTERN.test(raw)) return raw

	const substituted = raw.replace(/[^a-zA-Z0-9_-]+/g, '_')
	const collapsed = substituted.replace(/_{2,}/g, '_')

	// Trailing underscores are stripped before the suffix joins on, so the join
	// cannot itself introduce a `__`. Below MIN_REPAIRED_LENGTH no repaired name
	// fits the budget at all, and the floor keeps the base one character wide so
	// the result is still a legal name for the caller to reject on length.
	const baseBudget = Math.max(budget - SUFFIX_LENGTH, MIN_REPAIRED_LENGTH - SUFFIX_LENGTH)
	const prefix = collapsed.slice(0, baseBudget).replace(/_+$/, '')
	const head = prefix.length > 0 ? prefix : 'tool'.slice(0, baseBudget)
	return `${head}_${stableHash(raw)}`
}
