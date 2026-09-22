/**
 * The derivation rules that turn Zen's and Go's upstream documents into a
 * model roster.
 *
 * Pure: no network, no file system, no logger. `fetch.ts` reads the sources and
 * `catalogue.ts` assembles a catalogue from them; the maintainer's generator
 * (`scripts/generate-zen-models.mjs`) imports these same functions to render
 * the bundled snapshot in `models.ts`, so the runtime refresh and the snapshot
 * can never parse the same page two different ways.
 *
 * ## Where each field comes from
 *
 * Routes come from the service's own documentation page, as the pair
 * (endpoint, AI SDK package) that page states per model. Both halves are read
 * and required to agree, because a page that changed shape must stop the run
 * rather than have one half guessed: the wire a model is served on is a routing
 * fact, and the wrong one is a request to the wrong endpoint rather than a
 * clean failure. A row may state its endpoint and no package, with the `-` the
 * page's own tables use for a cell that has no value: that row is read and
 * recorded with no wire, and `deriveService` reports it as a model it will not
 * carry. Losing a column, or carrying a marker that is not `-`, is the page
 * moving and stops the run.
 *
 * Prices come from the same page's per-1M-token table, at the base tier: the
 * unqualified row when a model has one, the "(Off-Peak)" row for the Go
 * DeepSeek entries that publish both, and the "(≤ n tokens)" row when a model
 * is only published as a tier pair. A model with no price row at all must
 * appear in that page's free-model list and is then zero — "no row" is never
 * quietly read as free.
 *
 * Limits, modalities, tool support and effort levels come from the matching
 * provider entry in models.dev. Its `npm` is deliberately NOT used as a route,
 * in either place models.dev states one: the provider-level field names a
 * single Chat-Completions package for both services, which would send the Go
 * Qwen rows — documented on `/messages` — to `/chat/completions`, and the
 * per-model `provider.npm` is stated for fewer than half the documented
 * models, so it cannot route the rest.
 *
 * The two services' own `/models` answers carry `id`, `object`, `created` and
 * `owned_by` and nothing else: they say a model EXISTS and nothing about how to
 * call it. An id served there and documented nowhere cannot be carried, only
 * reported.
 */

import type { ModelInputModality, ReasoningEffort } from '@namzu/sdk'

import type { ZenProtocol, ZenService } from '../models.js'

/**
 * A source that could not be read, or no longer has the shape these rules
 * parse. Never a curation decision: nothing a caller does to the catalogue
 * clears it, and a refresh that meets one must keep whatever it had before.
 */
export class ZenCatalogueSourceError extends Error {
	override readonly name = 'ZenCatalogueSourceError'
}

function unusable(message: string): never {
	throw new ZenCatalogueSourceError(message)
}

/**
 * Characters a model name may not carry: controls (C0, DEL, C1), format
 * characters (bidi overrides, zero-widths) and line or paragraph separators.
 *
 * A name is upstream text that a host prints as it is, in a terminal picker
 * among other places. An escape sequence in it would be an OSC 52 clipboard
 * write or a screen clear in every session that lists the model, and a bidi
 * override would show one name while meaning another. No real name needs any
 * of them, so a source whose name carries one is a source these rules refuse.
 */
const UNDISPLAYABLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** Whether `name` is safe to print as it is: no control, format or separator character. */
export function isDisplayableName(name: string): boolean {
	return !UNDISPLAYABLE.test(name)
}

function routeName(cell: string, page: string): string {
	const name = cell.trim()
	if (!isDisplayableName(name)) {
		unusable(
			`${page} has a route row whose model name, ${JSON.stringify(name)}, carries a control,\n  format or separator character. A name is printed as it is wherever the model is\n  listed, so the run stops rather than carry it.`,
		)
	}
	return name
}

/** A service, its documentation page, and the models.dev provider holding its limits. */
export const ZEN_SERVICES: readonly {
	readonly service: ZenService
	readonly page: string
	readonly provider: string
}[] = Object.freeze([
	{ service: 'zen', page: 'zen.mdx', provider: 'opencode' },
	{ service: 'go', page: 'go.mdx', provider: 'opencode-go' },
])

/**
 * Every (AI SDK package, endpoint) pair a page may state, and the protocol
 * each is. `kind` says how the endpoint names the model: the first three put
 * it in the body of a fixed path, Google puts it in the path itself.
 */
export const ROUTES: readonly {
	readonly npm: string
	readonly path: string
	readonly protocol: ZenProtocol
	readonly kind: 'path' | 'model'
}[] = Object.freeze([
	{ npm: '@ai-sdk/openai-compatible', path: '/chat/completions', protocol: 'chat', kind: 'path' },
	{ npm: '@ai-sdk/openai', path: '/responses', protocol: 'responses', kind: 'path' },
	{ npm: '@ai-sdk/anthropic', path: '/messages', protocol: 'messages', kind: 'path' },
	{ npm: '@ai-sdk/google', path: '/models/', protocol: 'google', kind: 'model' },
])

/** The Google route's tail: `models/<id>`, and nothing else. */
const MODEL_PATH = /^models\/[a-z0-9][a-z0-9.-]*$/

/** The SDK's input modalities, and the models.dev names that map onto them. */
export const MODALITIES: Readonly<Record<string, ModelInputModality>> = Object.freeze({
	text: 'text',
	image: 'image',
	pdf: 'document',
})

/** The service each base host serves, by the path prefix its endpoints carry. */
export const SERVICE_PREFIX: Readonly<Record<ZenService, string>> = Object.freeze({
	zen: '/zen/v1/',
	go: '/zen/go/v1/',
})

/** One route-table row. `npm` is undefined when the page states no wire. */
export interface ZenRouteRow {
	readonly name: string
	readonly id: string
	readonly endpoint: string
	readonly npm: string | undefined
}

/** One price-table row, in USD per million tokens. */
export interface ZenPriceRow {
	readonly name: string
	readonly input: number
	readonly output: number
}

/** A documentation page, split into the three tables the rules read. */
export interface ZenParsedPage {
	readonly routes: readonly ZenRouteRow[]
	readonly prices: readonly ZenPriceRow[]
	readonly freeNames: readonly string[]
}

/**
 * One `/models` answer, as the set of ids it says the service serves.
 *
 * The shape is asserted rather than assumed, and an answer with no ids in it is
 * refused: a service that returns nothing is a source that moved, and reading
 * it as "nothing is served" would turn an outage into an empty roster.
 */
export function parseServed(service: string, text: string): Set<string> {
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch (error) {
		unusable(
			`The ${service} /models answer is not JSON: ${error instanceof Error ? error.message : error}`,
		)
	}
	const data =
		body !== null && typeof body === 'object' ? (body as { data?: unknown }).data : undefined
	if (!Array.isArray(data)) {
		unusable(
			`The ${service} /models answer has no \`data\` array. It is the field the served roster\n  is read from, so a service that changed shape stops here.`,
		)
	}
	const ids = new Set<string>()
	for (const item of data) {
		const id = item !== null && typeof item === 'object' ? (item as { id?: unknown }).id : undefined
		if (typeof id !== 'string' || id.length === 0) {
			unusable(
				`The ${service} /models answer has an entry with no string \`id\`. Every id it\n  serves is checked against the catalogue, so an entry that cannot be read is\n  an id nobody checked.`,
			)
		}
		ids.add(id)
	}
	if (ids.size === 0) {
		unusable(
			`The ${service} /models answer lists no models at all. That is a source that moved,\n  not a service that serves nothing, and accepting it would empty the roster\n  for as long as the outage lasted.`,
		)
	}
	return ids
}

/**
 * Whether a line looks like a row of the route table.
 *
 * The account has to CLOSE, not merely to be attempted: a line shaped like a
 * route row that the route pattern did not capture is a page these rules no
 * longer read correctly, and dropping it silently is the defect the whole
 * arrangement exists to remove. Two shapes count, both measured against the
 * live pages:
 *
 *  - two or more backticked cells, which is a row carrying both its endpoint
 *    and its package;
 *  - three or more cells with at least one backticked cell, which is a row that
 *    kept a value and lost a column: an empty package cell leaves four cells,
 *    and a row whose package COLUMN is gone leaves three.
 *
 * The backtick guard keeps the wider rule off table separators
 * (`| --- | --- | --- | --- |` carries no code span), and a prose row that
 * quotes a code span has two cells.
 */
export function isRouteRowShaped(line: string): boolean {
	const ticked = [...line.matchAll(/`[^`]*`/g)].length
	const cells = line.split('|').length - 2
	return ticked >= 2 || (cells >= 3 && ticked >= 1)
}

/** A documentation page, split into the three tables the rules read. */
export function parsePage(
	text: string,
	{ page, service }: { readonly page: string; readonly service: string },
): ZenParsedPage {
	const routes: ZenRouteRow[] = []
	const prices: ZenPriceRow[] = []
	const freeNames: string[] = []
	const unroutable: string[] = []
	// The free-model list is the only place a model is stated to be served at no
	// charge, and it is a bullet list under its own heading. It is read as a
	// block rather than by scanning for prose that looks like it, because the
	// same page ends with per-model data-handling notes that are also bullets
	// and also name models — reading those as free models would be a silent
	// widening of anonymous access.
	let inFreeSection = false
	for (const line of text.split('\n')) {
		if (/^The free models:/.test(line)) {
			inFreeSection = true
			continue
		}
		if (inFreeSection) {
			const bullet = line.match(/^-\s+(.+?)\s+is\s/)
			if (bullet?.[1] !== undefined) {
				freeNames.push(bullet[1].trim())
				continue
			}
			if (line.trim().length > 0 && !line.startsWith('-')) inFreeSection = false
		}
		const route = line.match(
			/^\|\s*(.+?)\s*\|\s*([a-z0-9][a-z0-9.\-]*)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/,
		)
		if (route) {
			routes.push({
				name: routeName(route[1] as string, page),
				id: route[2] as string,
				endpoint: route[3] as string,
				npm: route[4] as string,
			})
			continue
		}
		// A route row may state NO wire: the package column carries the `-` the
		// page's own tables use for a cell with no value. Narrow on purpose — the
		// fourth cell has to be exactly that marker, and the name cell refuses a
		// `|`, so a five-cell line whose extra cell sits in the middle cannot be
		// read as a wireless route named after two cells.
		const wireless = line.match(
			/^\|\s*([^|]+?)\s*\|\s*([a-z0-9][a-z0-9.\-]*)\s*\|\s*`([^`]+)`\s*\|\s*-\s*\|$/,
		)
		if (wireless) {
			routes.push({
				name: routeName(wireless[1] as string, page),
				id: wireless[2] as string,
				endpoint: wireless[3] as string,
				npm: undefined,
			})
			continue
		}
		const price = line.match(/^\|\s*(.+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/)
		if (price) {
			// A price cell is a dollar figure or the word "Free". Nothing else is
			// read, so a table whose columns mean something else cannot be picked
			// up by being three cells wide.
			const input = priceCell(price[2] as string)
			const output = priceCell(price[3] as string)
			if (input !== undefined && output !== undefined) {
				prices.push({ name: (price[1] as string).trim(), input, output })
				continue
			}
		}
		if (line.startsWith('|') && isRouteRowShaped(line)) unroutable.push(line.trim())
	}
	if (unroutable.length > 0) {
		unusable(
			`${page} has ${unroutable.length} line(s) shaped like a route row that this script\n  did not read as one. A model the page routes but this script does not capture is\n  a model that silently disappears from the catalogue, so the run stops instead:\n${unroutable
				.slice(0, 5)
				.map((line) => `    ${line}`)
				.join('\n')}${unroutable.length > 5 ? `\n    … and ${unroutable.length - 5} more` : ''}`,
		)
	}
	if (routes.length === 0) unusable(`${page} has no route table.`)
	if (service === 'zen' && freeNames.length === 0) {
		unusable(
			`${page} has no free-model list. Anonymous admission is stated there and is never\n  inferred from a zero price, so an empty list is a page that moved, not a\n  catalogue that serves nothing for free.`,
		)
	}
	return { routes, prices, freeNames }
}

/**
 * A price cell, or undefined when the cell is not a price.
 *
 * Go states its free models' rate as the word "Free" rather than as `$0.00`,
 * which is a statement about the price and not a missing one, so it is read as
 * zero.
 */
export function priceCell(cell: string): number | undefined {
	const dollars = /^\$([0-9.]+)$/.exec(cell.trim())
	if (dollars) return Number(dollars[1])
	return /^free$/i.test(cell.trim()) ? 0 : undefined
}

/** Model names are matched across tables by their letters, digits and dots. */
export function nameKey(name: string): string {
	return name
		.toLowerCase()
		.replace(/\([^)]*\)/g, '')
		.replace(/[^a-z0-9.]/g, '')
}

/**
 * The base-tier price row for a model: the unqualified row, the "(≤ …)" row of
 * a tier pair, or the "(Off-Peak)" row of a peak/off-peak pair.
 */
export function priceRowFor(rows: readonly ZenPriceRow[], name: string): ZenPriceRow | undefined {
	const candidates = rows.filter((row) => nameKey(row.name) === nameKey(name))
	if (candidates.length === 0) return undefined
	return (
		candidates.find((row) => /off-peak/i.test(row.name)) ??
		candidates.find((row) => !row.name.includes('(')) ??
		candidates.find((row) => row.name.includes('≤'))
	)
}

/**
 * The protocol a (package, endpoint) pair is, refusing anything unrecognised.
 *
 * The pair is checked against the URL's own parts rather than by substring: a
 * cell reading `https://evil.example/messages` contains the path a Messages
 * route has, and a routing decision that accepts it is a routing decision made
 * on the wrong string. Host, service prefix, path and package must all agree.
 */
export function protocolFor(
	{ id, endpoint, npm }: Pick<ZenRouteRow, 'id' | 'endpoint' | 'npm'>,
	service: string,
): ZenProtocol {
	const refuse = (why: string): never =>
		unusable(
			`"${id}" is documented as ${npm} on ${endpoint}, ${why}. A model whose wire is not\n  known cannot be routed, so the run stops rather than picking one.`,
		)
	if (npm === undefined) {
		unusable(
			`"${id}" is documented on ${endpoint} with no AI SDK package stated, so no wire is\n  known. A model whose wire is not known cannot be routed, so the run stops\n  rather than picking one.`,
		)
	}
	let url: URL
	try {
		url = new URL(endpoint)
	} catch {
		return refuse('which is not a URL')
	}
	if (url.host !== 'opencode.ai') refuse("whose host is not the service's")
	const prefix = (SERVICE_PREFIX as Record<string, string | undefined>)[service]
	if (prefix === undefined) return refuse('on a service this script does not know')
	if (!url.pathname.startsWith(prefix)) refuse(`which is not on the ${service} service's own path`)
	const route = ROUTES.find((candidate) => candidate.npm === npm)
	if (!route) {
		return refuse(
			`with a package that is not one of the ${ROUTES.length} routes this driver implements`,
		)
	}
	const tail = url.pathname.slice(prefix.length)
	const matches = route.kind === 'path' ? tail === route.path.slice(1) : MODEL_PATH.test(tail)
	if (!matches) refuse(`which does not address ${route.path} on the ${service} service`)
	return route.protocol
}

/** A models.dev model entry, as far as these rules read it. */
interface ModelsDevEntry {
	readonly limit?: { readonly context?: number; readonly output?: number }
	readonly modalities?: { readonly input?: readonly string[] }
	readonly tool_call?: boolean
	readonly reasoning_options?: readonly { readonly type?: string; readonly values?: unknown }[]
}

/** A models.dev provider entry: its models, keyed by id. */
export interface ModelsDevProvider {
	readonly models: Readonly<Record<string, unknown>>
}

/** One model a service's derivation carries, before it becomes a `ZenModel`. */
export interface DerivedZenModel {
	readonly id: string
	readonly name: string
	readonly protocol: ZenProtocol
	readonly contextWindow: number
	readonly maxOutputTokens: number
	readonly inputModalities: ModelInputModality[]
	readonly inputPrice: number
	readonly outputPrice: number
	readonly supportsToolUse: boolean
	readonly effortLevels: ReasoningEffort[]
	readonly supportsAnonymousAccess: boolean
}

/** Everything one service's derivation produced, carried and not. */
export interface DerivedZenService {
	readonly models: DerivedZenModel[]
	/** `[service/id, why]`: documented models it did not carry and nothing omits. */
	readonly undecided: [string, string][]
	/** Omitted ids upstream neither documents nor serves any more. */
	readonly stale: string[]
	/** Price rows no route row names. */
	readonly orphanPrices: string[]
	/** Ids the service serves that its page does not document and nothing omits. */
	readonly servedUncurried: string[]
}

/** Omission decisions, as the review file's record or as a set of `service/id` keys. */
export type ZenOmissions = Readonly<Record<string, string>> | ReadonlySet<string>

function omissionKeys(omissions: ZenOmissions): ReadonlySet<string> {
	return omissions instanceof Set ? omissions : new Set(Object.keys(omissions))
}

/**
 * One service's carried models, plus everything either source names and the
 * catalogue does not carry.
 *
 * `served` is the set of ids the service's own `/models` answer carries, and it
 * is required rather than defaulted: a caller that forgot it would turn the
 * served dimension off silently.
 */
export function derive(
	service: string,
	parsed: ZenParsedPage,
	providerKey: string,
	provider: ModelsDevProvider,
	omissions: ZenOmissions,
	served: ReadonlySet<string>,
): DerivedZenService {
	const omitted = omissionKeys(omissions)
	const freeIds = new Set<string>()
	for (const name of parsed.freeNames) {
		const row = parsed.routes.find((candidate) => nameKey(candidate.name) === nameKey(name))
		if (!row) {
			unusable(
				`The free-model list names "${name}", which the route table does not. Anonymous\n  admission is derived from that pairing, so the page has moved.`,
			)
		}
		freeIds.add(row.id)
	}
	const documented = new Set(parsed.routes.map((row) => row.id))
	const routeNames = new Set(parsed.routes.map((row) => nameKey(row.name)))
	const orphanPrices = parsed.prices
		.filter((row) => !routeNames.has(nameKey(row.name)))
		.map((row) => row.name)
	const models: DerivedZenModel[] = []
	const undecided: [string, string][] = []
	const incomplete: string[] = []
	// The rows actually put to models.dev: an omitted row is never asked about,
	// and neither is one that states no wire — no answer there could make it
	// carryable.
	let considered = 0
	let silentOnTools = 0
	let modelsDevEntries = 0
	for (const row of parsed.routes) {
		if (omitted.has(`${service}/${row.id}`)) continue
		if (row.npm === undefined) {
			undecided.push([
				`${service}/${row.id}`,
				'the page states no AI SDK package for it, so no wire is known',
			])
			continue
		}
		considered += 1
		const metadata = provider.models[row.id] as ModelsDevEntry | undefined
		if (!metadata || typeof metadata !== 'object') {
			undecided.push([`${service}/${row.id}`, `models.dev has no \`${providerKey}\` entry`])
			continue
		}
		if (metadata.tool_call === undefined) silentOnTools += 1
		modelsDevEntries += 1
		const priceRow = priceRowFor(parsed.prices, row.name)
		if (!priceRow && !freeIds.has(row.id)) {
			undecided.push([`${service}/${row.id}`, 'the page neither prices it nor names it as free'])
			continue
		}
		const effort = (
			Array.isArray(metadata.reasoning_options) ? metadata.reasoning_options : []
		).find((option) => option?.type === 'effort')
		const inputModalities = (
			Array.isArray(metadata.modalities?.input) ? metadata.modalities.input : []
		)
			.map((modality) => MODALITIES[modality])
			.filter((modality): modality is ModelInputModality => modality !== undefined)
		const contextWindow = metadata.limit?.context
		const maxOutputTokens = metadata.limit?.output
		if (
			!isPositiveInteger(contextWindow) ||
			!isPositiveInteger(maxOutputTokens) ||
			inputModalities.length === 0
		) {
			incomplete.push(
				`${service}/${row.id} (context ${contextWindow}, output ${maxOutputTokens}, ${inputModalities.length} input modalities)`,
			)
			continue
		}
		// The page either prices the model or names it free; the guard above
		// refused every model that is neither. So the zero written when there is
		// no price row is a rate these rules KNOW, not a default.
		const inputPrice = priceRow ? priceRow.input : 0
		const outputPrice = priceRow ? priceRow.output : 0
		models.push({
			id: row.id,
			name: row.name,
			protocol: protocolFor(row, service),
			contextWindow,
			maxOutputTokens,
			inputModalities,
			inputPrice,
			outputPrice,
			supportsToolUse: metadata.tool_call === true,
			effortLevels: effortValues(effort?.values, `${service}/${row.id}`),
			// Anonymous admission is a Zen concept: the Go constructor refuses an
			// absent key outright, so the flag would mean nothing on that service.
			supportsAnonymousAccess: service === 'zen' && freeIds.has(row.id),
		})
	}
	// Incomplete metadata is a source that moved, not a decision anybody makes:
	// an entry that is there and has lost the fields is models.dev having
	// changed shape, and every model reporting it at once is what a rename
	// looks like.
	if (incomplete.length > 0) {
		const all = incomplete.length === considered
		unusable(
			`${incomplete.length}${all ? ' — every one put to models.dev —' : ` of ${considered}`} model(s) on the\n  ${service} page have an entry in models.dev that is missing the fields the catalogue\n  needs. An entry that exists and has lost its limits is models.dev having changed\n  shape, not a curation decision, so this is reported as drift in the SOURCE:\n${incomplete
				.slice(0, 8)
				.map((line) => `    ${line}`)
				.join('\n')}${incomplete.length > 8 ? `\n    … and ${incomplete.length - 8} more` : ''}`,
		)
	}
	// A `tool_call` missing from every entry at once is a rename, and it is the
	// loss that fails QUIETLY: read as "no tools", it would rewrite the whole
	// roster to `supportsToolUse: false`. One entry of many is a real answer.
	if (modelsDevEntries > 0 && silentOnTools === modelsDevEntries) {
		unusable(
			`All ${modelsDevEntries} models.dev entr${modelsDevEntries === 1 ? 'y' : 'ies'} for the ${service}\n  provider omit \`tool_call\`. A field that vanished from every entry at once is models.dev\n  having changed shape, not every model losing its tools, so this is reported as a\n  SOURCE failure rather than written into the catalogue as \`supportsToolUse: false\`.`,
		)
	}
	const servedUncurried = [...served]
		.filter((id) => !documented.has(id) && !omitted.has(`${service}/${id}`))
		.sort()
	// An omission expires when upstream stops naming the model at all: neither
	// its page nor the service that serves it.
	const stale = [...omitted]
		.filter((key) => key.startsWith(`${service}/`))
		.map((key) => key.slice(service.length + 1))
		.filter((id) => !documented.has(id) && !served.has(id))
	return { models, undecided, stale, orphanPrices, servedUncurried }
}

const EFFORTS: ReadonlySet<string> = new Set([
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
])

function effortValues(values: unknown, key: string): ReasoningEffort[] {
	if (values === undefined) return []
	if (!Array.isArray(values)) unusable(`models.dev states effort options for ${key} as a non-list.`)
	for (const value of values) {
		if (typeof value !== 'string' || !EFFORTS.has(value)) {
			unusable(
				`models.dev states an effort level ${JSON.stringify(value)} for ${key}, which the SDK\n  has no \`ReasoningEffort\` for. A level the driver cannot send is not carried by guessing.`,
			)
		}
	}
	return [...(values as ReasoningEffort[])]
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * Refuse a roster that collapsed.
 *
 * A roster that came out empty, or that lost a fifth of what the baseline
 * carries, is a source that moved far more often than a decision anybody made,
 * and both look identical to a successful run from the inside.
 */
export const ROSTER_FLOOR = 0.8

export function checkRosterFloor(
	built: Readonly<Record<ZenService, readonly unknown[]>>,
	committed: Readonly<Record<ZenService, readonly unknown[]>>,
): void {
	for (const { service } of ZEN_SERVICES) {
		const derived = built[service].length
		const carried = committed[service].length
		if (derived === 0) {
			unusable(
				`The ${service} roster came out empty. Every documented model was rejected — a\n  catalogue with nothing in it is not a result, and a review file that omits\n  every model produces exactly this. Refusing rather than writing it.`,
			)
		}
		if (carried > 0 && derived < carried * ROSTER_FLOOR) {
			unusable(
				`The ${service} roster fell from ${carried} models to ${derived}, past the floor of\n  ${ROSTER_FLOOR * 100}% of what is committed. A fall that size is far more likely to be a source\n  that changed shape than a decision somebody made, so it is reported as one.\n  If upstream really did withdraw that many models, change ROSTER_FLOOR in\n  packages/providers/zen/src/catalogue/derive.ts and say so in the commit.`,
			)
		}
	}
}
