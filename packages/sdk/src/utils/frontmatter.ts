/**
 * The one frontmatter reader.
 *
 * A `SKILL.md`, a command file, and anything else this kernel reads from a
 * markdown file with a `---` fence all come through here. There were three
 * readers before this one and two of them disagreed on the same input: this
 * one **threw** on malformed frontmatter, and a second **silently returned no
 * metadata**, so the same file was a hard error in one code path and a skill
 * named after its own directory with "(no description)" in the other. Refuse
 * versus degrade, on one file shape, is the divergence this module exists to
 * end — see `docs/conventions/refuse-do-not-degrade.md`.
 *
 * **Deliberately not a YAML parser.** It is a flat key/value splitter with one
 * level of nesting, and it refuses the constructs in {@link UNSUPPORTED_YAML}
 * rather than mangling them. That refusal is the design: a reader that
 * half-understands YAML produces a value that passes validation and means
 * nothing.
 *
 * **Known gap, stated rather than implied.** The refusal is not yet total. A
 * *block* sequence
 *
 * ```yaml
 * allowed-tools:
 *   - Read
 * ```
 *
 * is silently dropped — its lines carry no `:` and are skipped — while the
 * flow form `[Read, Grep]` throws. Both readers this replaced behaved that
 * way, so it is inherited rather than introduced, but it contradicts
 * `docs/conventions/refuse-do-not-degrade.md` and is tracked as a follow-up.
 * Do not read the paragraph above as a guarantee it does not make.
 *
 * **Vocabulary belongs to the caller.** This returns the parsed map; it does
 * not know what a skill needs or what a command needs, and it validates no
 * field names. Widening one caller's metadata type to cover another's is how a
 * skill-shaped API comes to mean something it does not.
 */

/**
 * A closing fence is a line of its own, not `---` wherever it appears.
 *
 * An unanchored search found `---` inside a quoted value, inside a URL, inside
 * prose — and cut the frontmatter there, which both truncated the metadata AND
 * spilled the rest of it into the body, where it reaches the system prompt
 * verbatim.
 *
 * `\r?` is explicit rather than incidental. `$` under `/m` already matches
 * before a `\r` because JavaScript counts `\r` as a line terminator, so this
 * pattern worked on CRLF by accident before it worked on purpose. Naming the
 * carriage return keeps the next edit from removing a property nobody knew was
 * being relied on — a file authored on Windows is the ordinary case, not the
 * exotic one.
 */
const FRONTMATTER_FENCE = /^---[ \t]*\r?$/m

const FRONTMATTER_DELIMITER = '---'

/**
 * Splits on any of the three line endings — CRLF, LF, and a lone CR.
 *
 * The `\r?\n` half is defence in depth and was measured as such: reducing it to
 * `/\n/` fails no test, because {@link normalizeScalar} trims the stray `\r`
 * off every value anyway. The fence is the load-bearing half for CRLF, and that
 * one has a mutation profile.
 *
 * The lone `\r` is not decoration. Without it a CR-only file is one single
 * "line", and the whole frontmatter collapses into the first key: `name` came
 * back as `"a-skill\rdescription: d"` — a *wrong value*, silently, which is the
 * failure this module exists to end.
 *
 * `loadSkill` was accidentally protected, though not in the way first written
 * here: the collapse leaves no `description` key at all, so the required-field
 * check refused the file before any value could be used. A caller that
 * validates nothing — which is every caller this is now exported for — would
 * have taken the mangled name.
 */
const LINE_SPLIT = /\r\n|\r|\n/

/**
 * YAML this reader does not implement, refused rather than mangled.
 *
 * The documented contract says "YAML frontmatter" with no restriction — so an
 * author has every reason to write a block scalar or a flow sequence, and no
 * reason to expect what happened next. A `description: >-` followed by an
 * indented paragraph produced the literal string `">-"`, which passed
 * validation and registered with no warning; the skill then existed and was
 * never selected, because its description said nothing. A `[Read, Grep]`
 * became that literal text and was interpolated straight into the prompt.
 *
 * Refusing names the line and the file. That is worse for exactly one file —
 * the one already silently broken — and better for everyone looking for it.
 */
const UNSUPPORTED_YAML = [
	{ pattern: /^[>|][-+]?\s*$/, what: 'a block scalar (`>` or `|`)' },
	{ pattern: /^\[.*\]$/, what: 'a flow sequence (`[a, b]`)' },
	{ pattern: /^\{.*\}$/, what: 'a flow mapping (`{a: b}`)' },
] as const

export interface ParsedFrontmatter {
	/**
	 * Top-level `key: value` scalars. A key whose value is empty is omitted —
	 * it is a block header, not a value.
	 */
	readonly data: Readonly<Record<string, string>>

	/**
	 * Indented `key: value` lines, grouped under the top-level key that
	 * precedes them. One level only; this reader does not nest further.
	 *
	 * Kept separate from {@link data} rather than folded into it as a union so
	 * that a key carrying both a scalar and a block keeps both, and so a caller
	 * reading `data.x` never has to narrow a string against a record.
	 */
	readonly blocks: Readonly<Record<string, Readonly<Record<string, string>>>>

	/** Everything after the closing fence, trimmed. */
	readonly body: string
}

/**
 * Parse a markdown file's `---` frontmatter.
 *
 * @param raw The file's full contents. LF and CRLF both parse.
 * @param source A label for error messages — a path, or a phrase naming the
 *   file. Used verbatim, so the caller controls how its own errors read.
 * @throws If the frontmatter is absent, unclosed, or uses YAML this reader
 *   does not implement. It never returns a partial or empty result to stand in
 *   for a file it could not read.
 */
export function parseFrontmatter(raw: string, source: string): ParsedFrontmatter {
	const trimmed = raw.trimStart()

	if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
		throw new Error(`${source} has no YAML frontmatter`)
	}

	const closing = FRONTMATTER_FENCE.exec(trimmed.slice(FRONTMATTER_DELIMITER.length))
	if (!closing) {
		throw new Error(`${source} has unclosed frontmatter`)
	}

	const endIdx = FRONTMATTER_DELIMITER.length + closing.index
	const frontmatterRaw = trimmed.slice(FRONTMATTER_DELIMITER.length, endIdx).trim()
	const body = trimmed.slice(endIdx + closing[0].length).trim()

	// `Map`, not an object literal, because the keys come from an untrusted
	// file. `blocks[key] = …` on a plain object with `key === '__proto__'`
	// reaches `Object.prototype` through the inheritance chain and writes
	// **there** — a frontmatter file could set `Object.prototype.metadata` and
	// poison every object in the process. That is not theoretical: it was
	// caught here by an adversarial pass, and the poisoned prototype then
	// showed up in the metadata of an unrelated skill loaded afterwards.
	// A `Map` has no prototype chain for string keys, and `Object.fromEntries`
	// *defines* own properties rather than assigning through setters, so the
	// round trip is safe at both ends.
	const data = new Map<string, string>()
	const blocks = new Map<string, Map<string, string>>()
	let currentKey: string | undefined

	for (const line of frontmatterRaw.split(LINE_SPLIT)) {
		if (!line.trim() || line.trimStart().startsWith('#')) continue

		if (/^\s/.test(line)) {
			if (!currentKey) continue
			const colonIdx = line.indexOf(':')
			if (colonIdx === -1) continue
			const key = line.slice(0, colonIdx).trim()
			const value = normalizeScalar(line.slice(colonIdx + 1))
			if (!key || !value) continue
			let block = blocks.get(currentKey)
			if (!block) {
				block = new Map<string, string>()
				blocks.set(currentKey, block)
			}
			block.set(key, value)
			continue
		}

		const colonIdx = line.indexOf(':')
		if (colonIdx === -1) continue
		const key = line.slice(0, colonIdx).trim()
		const value = normalizeScalar(line.slice(colonIdx + 1))

		assertReadableScalar(key, value, source)

		currentKey = key
		if (value) data.set(key, value)
	}

	return {
		data: Object.fromEntries(data),
		blocks: Object.fromEntries([...blocks].map(([k, v]) => [k, Object.fromEntries(v)])),
		body,
	}
}

function normalizeScalar(value: string): string {
	return value
		.trim()
		.replace(/^["']|["']$/g, '')
		.trim()
}

function assertReadableScalar(key: string, value: string, source: string): void {
	for (const { pattern, what } of UNSUPPORTED_YAML) {
		if (!pattern.test(value)) continue
		throw new Error(
			`${source}: "${key}" uses ${what}, which this reader does not support. Write it as a single-line value instead. Refusing rather than accepting a "${key}" that would read as ${JSON.stringify(value)}.`,
		)
	}
}
