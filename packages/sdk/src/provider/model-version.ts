/**
 * Parse a versioned model id, given the vocabulary that names one.
 *
 * Several vendors spell an id the same way — a product segment, a family, a
 * major version, sometimes a minor, and sometimes an 8-digit release date:
 *
 * ```
 * <product>-<family>-<major>[-<minor>][-<YYYYMMDD>]
 * ```
 *
 * The SHAPE is general and lives here; the vocabulary is not, and is supplied
 * by the driver that knows it. That split is deliberate: a driver package
 * exists to speak one service's dialect, and the kernel has no business
 * knowing whose ids these are.
 *
 * It exists at all because three drivers had each written the same matcher and
 * all three had the same defect: the minor-version group was `\d+`, which
 * happily swallowed the date. An id naming no minor therefore parsed as
 * `major.<the date>` and compared as enormously NEWER than one that does, so
 * every capability gate keyed on `minor >= n` inverted for exactly those ids —
 * a model was told it supported features it does not.
 *
 * A real minor version is one to three digits; a date is exactly eight.
 * Bounding the group is what stops it reaching across the separator, and the
 * expression then backtracks into leaving the minor absent so the date suffix
 * can match where it belongs.
 */

export interface ModelVersion {
	readonly family: string
	readonly major: number
	/** `0` when the id names no minor — a bare major is `<major>.0`. */
	readonly minor: number
}

/**
 * What a driver must say to have its ids parsed.
 *
 * Every field is a wire value the driver already carries. Passing them in
 * rather than hard-coding them is what keeps this module free of any one
 * service's names.
 */
export interface ModelIdGrammar {
	/** The product segment an id begins with. */
	readonly product: string
	/** The family segment that follows it. */
	readonly families: readonly string[]
	/** An optional routing segment a gateway may prepend, including its slash. */
	readonly routingPrefix?: string
}

const quoteMeta = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function expressionFor(grammar: ModelIdGrammar): RegExp {
	const routing = grammar.routingPrefix ? `(?:${quoteMeta(grammar.routingPrefix)})?` : ''
	// `.map(quoteMeta)` and not `.map(escape)`: the latter resolves to the
	// global, deprecated `escape()`, which percent-encodes instead of escaping
	// regex metacharacters — and would pass every test here, because no family
	// name contains a character either function changes.
	const families = grammar.families.map((f) => quoteMeta(f)).join('|')
	// `\d{1,3}` on the minor, not `\d+`. That single bound is the whole fix.
	return new RegExp(
		`^${routing}${quoteMeta(grammar.product)}-(${families})-(\\d+)(?:[-_.](\\d{1,3}))?(?:-\\d{8})?$`,
	)
}

/** `undefined` for anything the grammar does not describe — never a guess. */
export function parseVersionedModelId(
	id: string,
	grammar: ModelIdGrammar,
): ModelVersion | undefined {
	const match = id.toLowerCase().match(expressionFor(grammar))
	if (!match) return undefined
	return {
		family: match[1] as string,
		major: Number(match[2]),
		minor: match[3] === undefined ? 0 : Number(match[3]),
	}
}

/**
 * Whether an id names a version at or above `major.minor`.
 *
 * The comparison every caller was writing by hand. An id this cannot parse
 * returns `false`: a capability gate must not open for a name it does not
 * understand, which is the fail-safe reading and the one those callers' own
 * comments already claimed.
 */
export function modelVersionAtLeast(
	id: string,
	grammar: ModelIdGrammar,
	major: number,
	minor: number,
): boolean {
	const version = parseVersionedModelId(id, grammar)
	if (!version) return false
	return version.major > major || (version.major === major && version.minor >= minor)
}
