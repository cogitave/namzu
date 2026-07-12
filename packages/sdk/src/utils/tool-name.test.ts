/**
 * Current-code invariants asserted (2026-07-12, ses_016 fix batch; revised
 * 2026-07-12 by the ses_015/016 pre-freeze fix rounds, findings B3 and its
 * follow-ups):
 *
 *   - `canonicalizeToolName` maps ANY string onto `^[a-zA-Z0-9_-]{1,64}$` and
 *     never throws. It exists for names we do not author: an MCP server or a
 *     connector advertises whatever it likes (`notion.search`, `db:query`, a
 *     70-character method name), and nobody on this side can rename a tool inside
 *     someone else's server. A remote name that fails validation used to abort an
 *     entire plugin enable.
 *   - **The function is injective.** Its two outcomes live in disjoint spaces:
 *     an untouched name (already valid, in budget, `__`-free, and NOT wearing the
 *     reserved suffix shape) comes back as itself; anything else comes back as
 *     `<base>_<hash7>` of the ORIGINAL raw string, which always wears that shape.
 *     Two rounds of this were needed. Sanitizing alone collapsed `a.b`, `a/b`,
 *     `a__b` and `a_b` onto one key. Adding the hash fixed that but left a second
 *     hole: a repaired name is itself a legal name, so a server advertising the
 *     literal `a_b_04la3gs` took the untouched path and landed on top of
 *     `canonicalizeToolName('a.b')`. Reserving the suffix shape closes it —
 *     distinct raw names can now collide only on a genuine 32-bit hash collision,
 *     never through aliasing and never through arrival order.
 *   - The reserved shape is `_[01][0-9a-z]{6}`, narrow by arithmetic rather than
 *     by convention: a 32-bit hash rendered base36 and padded to seven digits
 *     always opens with `0` or `1`. So `send_message` and `get_weather` do NOT
 *     wear it and stay readable, while `tool_04la3gs` does and is repaired.
 *   - No `__` survives, anywhere — not in the base, and not at the seam where the
 *     hash suffix joins on. The double underscore is the plugin namespace
 *     separator; a canonicalized name carrying one would be indistinguishable from
 *     a composed `plugin__tool` and would break the injectivity every name-keyed
 *     layer (vetoes, hooks, the verification gate) depends on.
 *   - `maxLength` is the budget the name ACTUALLY has, which for a plugin's MCP
 *     leaf is what `plugin__server__` leaves of the 64. Budgeting the hash suffix
 *     against the standalone 64 instead pushed a repaired leaf past the limit at
 *     composition time and made a tool that used to fit disappear.
 *   - Determinism is the load-bearing property: the output is a pure function of
 *     the raw name and the budget, identical in every process and every release
 *     and independent of the order tools were registered in, so a canonicalized
 *     name persisted in a run history still resolves after a restart.
 */

import { describe, expect, it } from 'vitest'

import { TOOL_NAME_PATTERN } from '../constants/tools/index.js'
import { canonicalizeToolName } from './tool-name.js'

/** The shape a repair produces — and the shape an untouched name never wears. */
const RESERVED_SUFFIX = /_[01][0-9a-z]{6}$/

describe('canonicalizeToolName', () => {
	it('leaves an already-valid name untouched', () => {
		expect(canonicalizeToolName('read_file')).toBe('read_file')
		expect(canonicalizeToolName('mcp_notion_search')).toBe('mcp_notion_search')
		expect(canonicalizeToolName('list-items')).toBe('list-items')
	})

	it('repairs the names real MCP servers ship, tagging the repair', () => {
		// The readable base survives; the suffix is what keeps the mapping injective.
		expect(canonicalizeToolName('notion.search')).toMatch(/^notion_search_[a-z0-9]{7}$/)
		expect(canonicalizeToolName('db:query')).toMatch(/^db_query_[a-z0-9]{7}$/)
		expect(canonicalizeToolName('browser.navigate')).toMatch(/^browser_navigate_[a-z0-9]{7}$/)
		expect(canonicalizeToolName('read file')).toMatch(/^read_file_[a-z0-9]{7}$/)
	})

	it('keeps names distinct that sanitizing alone would have collapsed', () => {
		// The B3 kill case. Every one of these sanitizes to `a_b`. Before the hash
		// suffix, the first server enumerated took the key and the rest were dropped
		// as duplicates — so after a restart that enumerated them in a different
		// order, the SAME persisted canonical name invoked a DIFFERENT remote tool.
		const raws = ['a.b', 'a/b', 'a:b', 'a b', 'a__b', 'a___b', 'a-b']
		const canonical = raws.map((raw) => canonicalizeToolName(raw))

		expect(new Set(canonical).size).toBe(raws.length)
		for (const name of canonical) {
			expect(TOOL_NAME_PATTERN.test(name)).toBe(true)
			expect(name).not.toContain('__')
		}

		// `a-b` needs no repair at all, so it alone keeps its raw form.
		expect(canonicalizeToolName('a-b')).toBe('a-b')
	})

	it('collapses every "__" — the separator must stay unambiguous', () => {
		expect(canonicalizeToolName('a__b')).not.toContain('__')
		expect(canonicalizeToolName('a___b')).not.toContain('__')
		expect(canonicalizeToolName('a..b')).not.toContain('__')
		expect(canonicalizeToolName('a__b__c')).not.toContain('__')

		// A raw name carrying the separator is a repair, so it can never come back
		// looking like a name that was already legal.
		expect(canonicalizeToolName('a__b')).not.toBe('a_b')
		expect(canonicalizeToolName('a_b')).toBe('a_b')
	})

	it('truncates an over-long name deterministically, on the ORIGINAL string', () => {
		const long = `${'x'.repeat(70)}_tail`
		const first = canonicalizeToolName(long)
		const second = canonicalizeToolName(long)

		expect(first).toBe(second)
		expect(first.length).toBeLessThanOrEqual(64)
		expect(TOOL_NAME_PATTERN.test(first)).toBe(true)

		// Two long names sharing the first 56 characters must not collide: the hash is
		// taken over the whole original, not the surviving prefix.
		const sibling = `${'x'.repeat(70)}_other`
		expect(canonicalizeToolName(sibling)).not.toBe(first)
	})

	it('never emits "__" when shortening a name that truncates onto an underscore', () => {
		// The 56-char prefix ends in `_`; appending `_<hash>` naively would produce
		// `__` and mint a name that looks namespaced.
		const name = `${'a'.repeat(55)}_${'b'.repeat(20)}`
		const result = canonicalizeToolName(name)

		expect(result).not.toContain('__')
		expect(TOOL_NAME_PATTERN.test(result)).toBe(true)
	})

	it('produces a valid, distinct name for pathological input, and never throws', () => {
		const raws = ['', '...', '???', ' ', '🙂', '__', '  ']
		const canonical = raws.map((raw) => canonicalizeToolName(raw))

		for (const result of canonical) {
			expect(TOOL_NAME_PATTERN.test(result)).toBe(true)
			expect(result).not.toContain('__')
		}
		// Even the degenerate inputs, which share the fallback base `tool`, stay apart.
		expect(new Set(canonical).size).toBe(raws.length)
	})

	it('is stable for the same input across calls', () => {
		const raw = 'azure-devops.list_work_item_comments_for_iteration.v2.preview.long'
		expect(canonicalizeToolName(raw)).toBe(canonicalizeToolName(raw))
	})

	it('does not depend on the order names are canonicalized in', () => {
		// Restart stability: a registry rebuilt from a differently-ordered MCP
		// enumeration must produce byte-identical keys.
		const raws = ['notion.search', 'notion/search', 'notion:search', 'notion_search']
		const forwards = raws.map((raw) => canonicalizeToolName(raw))
		const backwards = [...raws]
			.reverse()
			.map((raw) => canonicalizeToolName(raw))
			.reverse()

		expect(forwards).toEqual(backwards)
		expect(new Set(forwards).size).toBe(raws.length)
	})
})

describe('canonicalizeToolName — the repaired space and the untouched space are disjoint', () => {
	it("does not let a raw name squat on another name's repaired form", () => {
		// The exact pair the pre-freeze review named. `a.b` repairs to `a_b_04la3gs`.
		// A server is free to advertise a tool literally CALLED `a_b_04la3gs`, and
		// that name is valid, so it used to pass through untouched and land on the
		// other tool's key — whereupon the lifecycle kept whichever it saw first, and
		// a restart that enumerated them the other way round retargeted a persisted
		// call. The squatter wears the reserved shape, so it is repaired too.
		const repaired = canonicalizeToolName('a.b')
		const squatter = canonicalizeToolName('a_b_04la3gs')

		expect(repaired).toBe('a_b_04la3gs')
		expect(squatter).not.toBe(repaired)
		expect(squatter).not.toBe('a_b_04la3gs')
		expect(squatter).toMatch(/^a_b_04la3gs_[0-9a-z]{7}$/)
	})

	it('gives every repaired name the reserved shape, and no untouched name it', () => {
		// The disjointness proof, mechanically. Whatever a raw name is, its canonical
		// form either IS the raw name (and then it does not wear the shape) or wears
		// the shape (and then it is not the raw name). A future change to the hash
		// width that broke the `[01]` opening would break this and be caught here.
		const raws = [
			'read_file',
			'send_message',
			'notion.search',
			'db:query',
			'a__b',
			'a_b',
			'a_b_04la3gs',
			'tool_1zzzzzz',
			'x'.repeat(80),
			'',
			'🙂',
		]

		for (const raw of raws) {
			const canonical = canonicalizeToolName(raw)
			expect(TOOL_NAME_PATTERN.test(canonical)).toBe(true)
			if (canonical === raw) {
				expect(RESERVED_SUFFIX.test(canonical)).toBe(false)
			} else {
				expect(RESERVED_SUFFIX.test(canonical)).toBe(true)
			}
		}
	})

	it('pins the exact names the published docs promise', () => {
		// `docs/migration/0.5.md`, `docs/sdk/integrations/plugins.md` and
		// `connectors-and-mcp.md` print these verbatim. They shipped once with invented
		// hashes, because nothing here held them to the real ones. Now something does.
		expect(canonicalizeToolName('notion.search')).toBe('notion_search_1gn6nda')
		expect(canonicalizeToolName('db:query')).toBe('db_query_0fa0aax')
		expect(canonicalizeToolName('read_file')).toBe('read_file')
		expect(canonicalizeToolName('mcp_notion_notion.search')).toBe(
			'mcp_notion_notion_search_0q4lhlv',
		)
	})

	it('keeps the reserved shape narrow enough to leave ordinary names readable', () => {
		// The shape is `_` + a base36 digit that can only be 0 or 1 + six more. A word
		// ending is not enough to trigger it, so the names real servers ship — which
		// overwhelmingly end in a word — are still passed through as themselves.
		expect(canonicalizeToolName('send_message')).toBe('send_message')
		expect(canonicalizeToolName('get_weather')).toBe('get_weather')
		expect(canonicalizeToolName('run_command')).toBe('run_command')
		expect(canonicalizeToolName('create_context')).toBe('create_context')
		expect(canonicalizeToolName('list_handlers')).toBe('list_handlers')
	})
})

describe('canonicalizeToolName — budget', () => {
	it('fits the name into the budget it is actually given, not the standalone 64', () => {
		// A plugin's MCP leaf is composed into `plugin__server__leaf`, so its real
		// budget is what the namespace leaves behind. Budgeting against 64 here made
		// the composed name overflow and the tool vanish.
		const leaf = canonicalizeToolName('x'.repeat(60), 31)

		expect(leaf.length).toBeLessThanOrEqual(31)
		expect(TOOL_NAME_PATTERN.test(leaf)).toBe(true)
		expect(RESERVED_SUFFIX.test(leaf)).toBe(true)
	})

	it('keeps a leaf that fit before the hash suffix fitting inside its namespace', () => {
		// The regression the suffix introduced: `plugin-with-a-long-name__server__`
		// costs 33 characters, leaving 31. This leaf needs repair, and the old code
		// sized the base against 64 — producing a 64-character leaf that composed to
		// 97 and was dropped. It has to survive.
		const prefix = 'plugin-with-a-long-name__server__'
		const budget = 64 - prefix.length
		const leaf = canonicalizeToolName('a.long.remote.method.name.that.needs.repair', budget)

		expect(`${prefix}${leaf}`.length).toBeLessThanOrEqual(64)
	})

	it('stays injective under a tight budget', () => {
		// Truncation is where injectivity is easiest to lose: these four share their
		// first 40 characters and differ only past the cut. The hash is taken over the
		// whole original, so the cut cannot merge them.
		const stem = 'server.method.with.a.very.long.common.stem'
		const raws = [`${stem}.one`, `${stem}.two`, `${stem}.three`, `${stem}.four`]
		const canonical = raws.map((raw) => canonicalizeToolName(raw, 20))

		expect(new Set(canonical).size).toBe(raws.length)
		for (const name of canonical) {
			expect(name.length).toBeLessThanOrEqual(20)
			expect(TOOL_NAME_PATTERN.test(name)).toBe(true)
			expect(name).not.toContain('__')
		}
	})

	it('emits the minimal repaired name when no repaired name can fit, and still never throws', () => {
		// Below nine characters there is no repaired name at all: one base character
		// plus `_` plus seven hash digits is the floor. The caller's own length check
		// is what rejects this — a throw here would take down the whole plugin enable
		// over a tool nobody on this side is allowed to rename.
		const leaf = canonicalizeToolName('notion.search', 4)

		expect(leaf.length).toBe(9)
		expect(TOOL_NAME_PATTERN.test(leaf)).toBe(true)
	})

	it('leaves a short valid name untouched even under a tight budget', () => {
		expect(canonicalizeToolName('ok', 7)).toBe('ok')
	})

	// ses_015 pre-freeze H2. Pinned as INTENDED behaviour, not tolerated as a bug:
	// the reserved suffix shape is what keeps the repaired space disjoint from the
	// identity space, and a repaired name wears that shape, so it must itself be
	// repaired when fed back in. Idempotence and injectivity are mutually exclusive
	// here, and injectivity is what keeps a persisted name resolving to the tool it
	// was persisted for. Anyone "fixing" this into idempotence — by passing a
	// reserved-shaped input through untouched — reopens the collision hole where a
	// server advertising the literal string `a_b_04la3gs` lands on top of the
	// canonical name of `a.b`. The contract that makes non-idempotence safe is
	// positional: apply exactly once, at the ingest boundary.
	it('is deliberately NOT idempotent — re-canonicalizing a canonical name mints a new one', () => {
		const once = canonicalizeToolName('a.b')
		const twice = canonicalizeToolName(once)

		expect(once).toBe('a_b_04la3gs')
		expect(twice).not.toBe(once)
		expect(RESERVED_SUFFIX.test(once)).toBe(true)
		expect(RESERVED_SUFFIX.test(twice)).toBe(true)
	})

	it('repairs a raw name that arrives already wearing the reserved shape', () => {
		// The other side of the same coin, and the reason the above cannot be "fixed":
		// this raw name is perfectly legal, but passing it through untouched would put
		// it in the identity space wearing a repaired shape — exactly on top of
		// canonicalizeToolName('a.b').
		const raw = 'a_b_04la3gs'
		const canonical = canonicalizeToolName(raw)

		expect(canonical).not.toBe(raw)
		expect(canonical).not.toBe(canonicalizeToolName('a.b'))
	})
})
