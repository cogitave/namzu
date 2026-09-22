#!/usr/bin/env node
/**
 * Refresh the BUNDLED Zen catalogue snapshot by hand.
 *
 *   node scripts/generate-zen-models.mjs            # fetch upstream, rewrite models.ts
 *   node scripts/generate-zen-models.mjs --check    # fetch upstream, diff, exit 1 on drift
 *   node scripts/generate-zen-models.mjs --from DIR # read the SOURCES from DIR instead of
 *                                                   # the network — the two pages, the
 *                                                   # models.dev document, the two /models
 *                                                   # answers, DIR/models.review.json and
 *                                                   # DIR/models.ts, each when it is there
 *
 * Run `pnpm --filter @namzu/zen build` first: the parsing rules are not in this
 * file. They live in `@namzu/zen` (`src/catalogue/`), where the CLI runs them
 * on every launch to refresh its catalogue in the background, and this script
 * imports the built module so the snapshot and the runtime refresh can never
 * read one page two different ways. What stays here is what only a maintainer
 * needs: the review file, rendering `models.ts` through the formatter, and the
 * report of what a refresh would change.
 *
 * The snapshot is the floor a consumer stands on when nothing fresher is
 * available — an embedder that never opts into a refresh, a CLI launch with no
 * network and no last-good cache. Nothing gates it in CI any more: upstream
 * moving is what the runtime refresh absorbs, and a gate that turned `main` red
 * whenever it did measured upstream rather than this repository.
 *
 * Exit codes: 0 in agreement, 1 a decision somebody has to make — the module
 * disagrees with its sources, or a source names a model the catalogue neither
 * carries nor omits — and 2 a source could not be read, no longer has the shape
 * the rules parse, or the formatter is not installed. An unbuilt `@namzu/zen`
 * fails before any of that, as a module-not-found naming the missing
 * `dist/catalogue/` file.
 *
 * ## What is curated
 *
 * A model a page documents must be either CARRIED or OMITTED with a reason in
 * `packages/providers/zen/src/models.review.json`; a refresh refuses to write
 * while one is neither. An id the service serves and no page documents has no
 * route to derive, so it cannot be carried, and it is exit 1 in both modes
 * until somebody records the decision — though a refresh still WRITES while one
 * of those stands, because the roster it derives is unaffected. An omission for
 * a model upstream neither documents nor serves any more is stale and fails
 * too. The omission keys are rendered into `models.ts` as `ZEN_OMITTED_MODELS`,
 * which is how the runtime refresh honours the same decisions.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildZenCatalogue } from '../packages/providers/zen/dist/catalogue/catalogue.js'
import {
	MODALITIES,
	ROUTES,
	ZEN_SERVICES,
	checkRosterFloor,
	derive,
	isRouteRowShaped,
	nameKey,
	parsePage,
	parseServed,
	priceCell,
	priceRowFor,
	protocolFor,
} from '../packages/providers/zen/dist/catalogue/derive.js'
import {
	ZEN_DOCS_REF,
	ZEN_SERVICE_BASE,
	fetchZenCatalogueSources,
	fetchZenServedRosters,
} from '../packages/providers/zen/dist/catalogue/fetch.js'

// The rules, re-exported so this script's own tests exercise the code the
// snapshot is actually rendered through.
export {
	MODALITIES,
	ROUTES,
	checkRosterFloor,
	derive,
	isRouteRowShaped,
	nameKey,
	parsePage,
	parseServed,
	priceCell,
	priceRowFor,
	protocolFor,
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ZEN_DIR = join(HERE, '..', 'packages', 'providers', 'zen')
const OUTPUT_PATH = join(ZEN_DIR, 'src', 'models.ts')
const REVIEW_PATH = join(ZEN_DIR, 'src', 'models.review.json')
const REVIEW_REF = 'packages/providers/zen/src/models.review.json'

/**
 * `--from DIR` replaces every source this script reads, including the review
 * file and the module under test, so the offline mode is a COMPLETE
 * reproduction rather than a partial one.
 */
const FROM_DIR = (() => {
	const index = process.argv.indexOf('--from')
	// An empty string rather than undefined when the flag is given without a
	// value, so `--from` on its own fails instead of quietly fetching.
	return index === -1 ? undefined : (process.argv[index + 1] ?? '')
})()

/** The branch to read the service's documentation from. `dev` is its default. */
const DOCS_REF = process.env.NAMZU_ZEN_DOCS_REF ?? ZEN_DOCS_REF
/**
 * The host the two services' own `/models` endpoints hang off. Overridable so a
 * test can drive the fetch without the network, or an operator can point the
 * run at a mirror. A host that does not answer is exit 2, never a pass.
 */
const SERVICE_BASE = process.env.NAMZU_ZEN_MODELS_BASE ?? ZEN_SERVICE_BASE
/** A maintainer's run is patient where a CLI launch is not. */
const FETCH_OPTIONS = { docsRef: DOCS_REF, serviceBase: SERVICE_BASE, timeoutMs: 30_000, attempts: 3 }

/** The file each service's `/models` answer is cached as under `--from`. */
const SERVED_FILE = { zen: 'served.zen.json', go: 'served.go.json' }

class UnusableSourceError extends Error {}

function unusable(error) {
	const detail = error instanceof Error ? error.message : String(error)
	console.error('✗ ZEN CATALOGUE SOURCE UNUSABLE\n')
	console.error(`  ${detail}`)
	console.error(
		'\n  This is not drift in packages/providers/zen/src/models.ts, and editing that\n' +
			'  file will not clear this. One of three things happened: the network to an\n' +
			'  upstream source is down, a source changed shape and the rules no longer\n' +
			'  read it correctly, or the formatter the script renders through is not\n' +
			'  installed. Run `pnpm install` if you have not.',
	)
	process.exit(2)
}

/**
 * A directory as a source, with every file it names required to be there: a
 * run that took some of its sources from a directory and quietly got the rest
 * from the network would answer a question nobody asked.
 */
function requiredReader(dir) {
	if (!dir) throw new UnusableSourceError('--from needs a directory.')
	return (name) => {
		try {
			return readFileSync(join(dir, name), 'utf8')
		} catch {
			throw new UnusableSourceError(`${join(dir, name)} is missing.`)
		}
	}
}

/**
 * The five sources as texts: from the network, or from `--from DIR`.
 *
 * Under `--from`, the two `/models` answers follow the "when they are there"
 * rule the module and the review file already follow: a directory that holds
 * them is read, and one that does not asks the service — which is how the test
 * that drives the fetch points `NAMZU_ZEN_MODELS_BASE` at a server it owns.
 */
async function loadSources() {
	if (FROM_DIR === undefined) return fetchZenCatalogueSources(FETCH_OPTIONS)
	const read = requiredReader(FROM_DIR)
	const docs = { zen: read('zen.mdx'), go: read('go.mdx') }
	const modelsDev = read('models.dev.json')
	const optional = (name) => {
		try {
			return readFileSync(join(FROM_DIR, name), 'utf8')
		} catch {
			return undefined
		}
	}
	const [zen, go] = [optional(SERVED_FILE.zen), optional(SERVED_FILE.go)]
	const served =
		zen !== undefined && go !== undefined ? { zen, go } : await fetchZenServedRosters(FETCH_OPTIONS)
	return { docs, modelsDev, served }
}

/** Prices are written with a decimal point; a plain integer reads as a token count. */
function price(value) {
	return value === 0 ? '0' : Number.isInteger(value) ? `${value}.0` : String(value)
}

export function renderEntry(model) {
	const lines = ['\t{', `\t\tid: ${JSON.stringify(model.id)},`]
	if (model.supportsAnonymousAccess) lines.push('\t\tsupportsAnonymousAccess: true,')
	lines.push(
		`\t\tname: ${JSON.stringify(model.name)},`,
		`\t\tprotocol: '${model.protocol}',`,
		`\t\tcontextWindow: ${model.contextWindow},`,
		`\t\tmaxOutputTokens: ${model.maxOutputTokens},`,
		`\t\tinputModalities: [${model.inputModalities.map((m) => `'${m}'`).join(', ')}],`,
		`\t\tinputPrice: ${price(model.inputPrice)},`,
		`\t\toutputPrice: ${price(model.outputPrice)},`,
		`\t\tsupportsToolUse: ${model.supportsToolUse},`,
		'\t\tsupportsStreaming: true,',
		`\t\teffortLevels: [${model.effortLevels.map((e) => `'${e}'`).join(', ')}],`,
		'\t},',
	)
	return lines.join('\n')
}

/**
 * The module's own header.
 *
 * The `Refreshed` line is the one piece of provenance here and the one line the
 * check ignores: it names the day this ROSTER last moved, which is not the
 * question "does this still match upstream". So a refresh that finds nothing
 * new writes nothing at all.
 */
function header(refreshed) {
	return `/*
 * GENERATED FILE — do not edit. Regenerate with:
 *
 *   pnpm --filter @namzu/zen build && node scripts/generate-zen-models.mjs
 *
 * A curation decision is an edit to src/models.review.json, and how a field is
 * derived is an edit to src/catalogue/derive.ts. Both survive regeneration; a
 * hand edit here does not.
 *
 * Refreshed: ${refreshed}
 *
 * This is the BUNDLED snapshot: what the driver knows with no network. A host
 * can derive a fresher roster at run time from the same sources, by the same
 * rules, through \`@namzu/zen/catalogue\` and hand it to the provider as
 * \`ZenConfig.catalogue\`; the CLI does that in the background on every launch.
 *
 * Routes come from each service's own documentation page, as the pair
 * (endpoint, AI SDK package) that page states per model; both halves must agree
 * or the run stops. Prices come from that page's per-1M-token table at the base
 * tier, and a model with no price row there must be named in the page's
 * free-model list and is then zero. Limits, tool support, modalities and effort
 * options come from the matching provider entry in models.dev, where the
 * upstream project keeps them. models.dev states an npm package for both
 * services — one per provider, and one per model for some of its entries.
 * Neither is used as a route: the provider-level one names a single
 * Chat-Completions package for both, which would send the Go Qwen rows —
 * documented on \`/messages\` — to Chat Completions, and the per-model one is
 * stated for fewer than half the documented models, so it cannot route the
 * rest.
 *
 * Not every model either service serves is carried here. A model that is
 * documented and not carried is omitted by name, with a reason, in
 * src/models.review.json, and the generator refuses to write while a
 * documented model is neither carried nor omitted. It also reads what the two
 * services' own \`/models\` answers say they serve: an id served and documented
 * nowhere has no derivable wire, so it is reported as a decision too, rather
 * than dropped by the driver in silence.
 *
 * Prices are estimates, not invoices: context tiers, cache, Go peak/off-peak
 * rates, subscription allowances and promotions can change the effective cost.
 * The table is read at its base tier, so Go DeepSeek entries are off-peak. PDF
 * input is the SDK's document modality; audio/video are omitted because the SDK
 * does not expose those input kinds.
 *
 * Promotional free models with documented routes and complete metadata are
 * included at their advertised zero price; the service enforces access limits.
 * Anonymous admission is explicit rather than inferred from price, and comes
 * from the free-model list on the page. OpenCode's own loader uses the public
 * sentinel when credentials are absent:
 * https://github.com/anomalyco/opencode/blob/16747470f976aca3d362ad730bcd3fe82ecc2c9a/packages/opencode/src/provider/provider.ts#L185
 * Unknown IDs have no inferred protocol or limits. MiniMax and Qwen demonstrate
 * why routes must be recorded per service/model.
 */`
}

export function render(models, refreshed, omissions = []) {
	const omitted = [...omissions].sort()
	return `import type { ModelInputModality, ReasoningEffort } from '@namzu/sdk'

/** Zen's independently routed, billed services. */
export type ZenService = 'zen' | 'go'

/** Native wire format documented for this exact model and service. */
export type ZenProtocol = 'chat' | 'responses' | 'messages' | 'google'

/** A supported model in the pinned Zen catalogue. */
export interface ZenModel {
	readonly id: string
	readonly name: string
	readonly protocol: ZenProtocol
	readonly contextWindow?: number
	readonly maxOutputTokens?: number
	readonly inputModalities?: readonly ModelInputModality[]
	/** USD per million uncached input tokens at the documented base tier. */
	readonly inputPrice: number
	/** USD per million output tokens at the documented base tier. */
	readonly outputPrice: number
	readonly supportsToolUse: boolean
	readonly supportsStreaming: boolean
	/** True only for documented anonymous Zen models; omission grants no anonymous access. */
	readonly supportsAnonymousAccess?: boolean
	/** Exact advertised selectable effort levels; empty means no effort selector. */
	readonly effortLevels?: readonly ReasoningEffort[]
}

${header(refreshed)}
function freezeModels(models: ZenModel[]): readonly ZenModel[] {
	for (const model of models) {
		if (model.inputModalities) Object.freeze(model.inputModalities)
		if (model.effortLevels) Object.freeze(model.effortLevels)
		Object.freeze(model)
	}
	return Object.freeze(models)
}

const ZEN_MODELS = freezeModels([
${models.zen.map(renderEntry).join('\n')}
])

const GO_MODELS = freezeModels([
${models.go.map(renderEntry).join('\n')}
])

/**
 * Reviewed omissions, as \`service/id\`: models a source names that this
 * snapshot deliberately does not carry. A runtime refresh through
 * \`@namzu/zen/catalogue\` honours the same decisions by default.
 */
export const ZEN_OMITTED_MODELS: readonly string[] = Object.freeze([
${omitted.map((key) => `\t${JSON.stringify(key)},`).join('\n')}
])

/** Supported metadata; actual account availability is established by live discovery. */
export function getZenModels(service: ZenService): readonly ZenModel[] {
	return service === 'zen' ? ZEN_MODELS : GO_MODELS
}

/** Exact wire ID lookup. Zen CLI prefixes and unknown IDs are not guessed. */
export function findZenModel(service: ZenService, id: string): ZenModel | undefined {
	return getZenModels(service).find((model) => model.id === id)
}
`
}

function biomeEntryPoint() {
	const candidates = [
		join(HERE, '..', 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
		join(ZEN_DIR, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
	]
	for (const candidate of candidates) {
		try {
			readFileSync(candidate)
			return candidate
		} catch {
			// try the next
		}
	}
	throw new UnusableSourceError(
		`Could not find the biome CLI. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}\n` +
			'Run `pnpm install` first — the generated module is formatted with the same\n' +
			'formatter the lint gate runs, so that the two cannot disagree about it.',
	)
}

export function formatted(source) {
	// Formatting the RENDERED STRING rather than the file on disk is what makes
	// the check sound: both sides go through the formatter, so it asks "is this
	// file what the generator produces?" and never "has anyone run a formatter
	// since?".
	return execFileSync(
		process.execPath,
		[biomeEntryPoint(), 'format', '--stdin-file-path=src/models.ts'],
		{ cwd: ZEN_DIR, input: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
	)
}

const REVIEW_KEY = /^(zen|go)\/[a-z0-9][a-z0-9.-]*$/

/** The review file the run should read: the fixture's when `--from` names one. */
export function reviewPath() {
	if (FROM_DIR !== undefined) {
		const candidate = join(FROM_DIR, 'models.review.json')
		try {
			readFileSync(candidate)
			return candidate
		} catch {
			// No reviewed decisions beside these sources: fall back to the tree's.
		}
	}
	return REVIEW_PATH
}

export function localDate(now) {
	const pad = (value) => String(value).padStart(2, '0')
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function readReview(path = REVIEW_PATH) {
	let parsed
	try {
		parsed = JSON.parse(readFileSync(path, 'utf8'))
	} catch (error) {
		throw new UnusableSourceError(`${path} could not be read: ${error.message}`)
	}
	const omissions = parsed.omissions
	if (!omissions || typeof omissions !== 'object' || Array.isArray(omissions)) {
		throw new UnusableSourceError(`${path} needs an \`omissions\` object.`)
	}
	for (const [key, reason] of Object.entries(omissions)) {
		if (!REVIEW_KEY.test(key)) {
			throw new UnusableSourceError(
				`${path} keys an omission "${key}". They are \`<service>/<model-id>\`.`,
			)
		}
		if (typeof reason !== 'string' || reason.trim().length === 0) {
			throw new UnusableSourceError(
				`${path} omits "${key}" with no reason. An omission without one is\n` +
					'  indistinguishable from a model nobody noticed.',
			)
		}
	}
	return omissions
}

/** The fields compared when reporting what moved on a model that stayed. */
const COMPARED_FIELDS = [
	'name',
	'protocol',
	'contextWindow',
	'maxOutputTokens',
	'inputModalities',
	'inputPrice',
	'outputPrice',
	'supportsToolUse',
	'effortLevels',
	'supportsAnonymousAccess',
]

/**
 * A catalogue model in the shape `parseRendered` reads back, so a comparison
 * between the two is about values and not about which keys are spelled out.
 */
function comparable(model) {
	return {
		id: model.id,
		name: model.name,
		protocol: model.protocol,
		contextWindow: model.contextWindow,
		maxOutputTokens: model.maxOutputTokens,
		inputModalities: [...model.inputModalities],
		inputPrice: model.inputPrice,
		outputPrice: model.outputPrice,
		supportsToolUse: model.supportsToolUse,
		effortLevels: [...model.effortLevels],
		supportsAnonymousAccess: model.supportsAnonymousAccess === true,
	}
}

/**
 * Read back a generated module, so a run can say what changed rather than
 * only that something did. It parses the shape `renderEntry` writes; a file
 * hand-edited into another shape is caught by the byte comparison after this.
 */
export function parseRendered(text) {
	const read = (constant) => {
		const start = text.indexOf(`const ${constant} = freezeModels([`)
		if (start === -1) return []
		const end = text.indexOf('\n])\n', start)
		const block = text.slice(start, end === -1 ? text.length : end)
		const entries = []
		for (const match of block.matchAll(/\{\n((?:\t\t\w+:.*\n)+?)\t\},/g)) {
			const body = match[1]
			const field = (key) => body.match(new RegExp(`^\\t\\t${key}: (.*),$`, 'm'))?.[1]
			const strings = (key) => {
				const raw = field(key)
				return raw === undefined ? undefined : [...raw.matchAll(/'([^']*)'/g)].map((m) => m[1])
			}
			// Ids and names go out through JSON.stringify — double-quoted — and
			// come back single-quoted from disk, because the formatter rewrites
			// the quotes. Reading the value, not the spelling.
			const scalar = (key) => {
				const raw = field(key)
				if (raw === undefined) return undefined
				const text = raw.trim()
				const quoted = /^(['"])([\s\S]*)\1$/.exec(text)
				return quoted ? quoted[2] : text
			}
			entries.push({
				id: scalar('id'),
				name: scalar('name'),
				protocol: field('protocol')?.replace(/'/g, ''),
				contextWindow: Number(field('contextWindow')),
				maxOutputTokens: Number(field('maxOutputTokens')),
				inputModalities: strings('inputModalities'),
				inputPrice: Number(field('inputPrice')),
				outputPrice: Number(field('outputPrice')),
				supportsToolUse: field('supportsToolUse') === 'true',
				effortLevels: strings('effortLevels'),
				supportsAnonymousAccess: field('supportsAnonymousAccess') === 'true',
			})
		}
		return entries
	}
	return { zen: read('ZEN_MODELS'), go: read('GO_MODELS') }
}

/** What this run would do to the roster, named. A removal is never silent. */
export function describeChanges(committed, built) {
	const lines = []
	for (const { service } of ZEN_SERVICES) {
		const before = new Map(committed[service].map((model) => [model.id, model]))
		const after = new Map(built[service].map((model) => [model.id, model]))
		const added = [...after.keys()].filter((id) => !before.has(id))
		const removed = [...before.keys()].filter((id) => !after.has(id))
		const changed = []
		for (const [id, model] of after) {
			const previous = before.get(id)
			if (!previous) continue
			const fields = COMPARED_FIELDS.filter(
				(field) => JSON.stringify(previous[field]) !== JSON.stringify(model[field]),
			)
			if (fields.length > 0) changed.push(`${id} (${fields.join(', ')})`)
		}
		if (added.length > 0) lines.push(`${service} added: ${added.join(', ')}`)
		if (removed.length > 0) lines.push(`${service} REMOVED: ${removed.join(', ')}`)
		if (changed.length > 0) {
			lines.push(
				`${service} changed: ${changed.slice(0, 8).join('; ')}` +
					(changed.length > 8 ? `; … and ${changed.length - 8} more` : ''),
			)
		}
	}
	if (lines.length === 0) {
		lines.push('no model was added, removed or altered — the difference is elsewhere in the file')
	}
	return lines
}

/**
 * Everything this run needs somebody to decide, printed as one report. Prints
 * nothing when there is nothing to decide.
 */
export function printDecisions(built) {
	const { undecided, stale, orphanPrices, servedUncurried } = built
	if (
		undecided.length === 0 &&
		stale.length === 0 &&
		orphanPrices.length === 0 &&
		servedUncurried.length === 0
	) {
		return
	}
	console.error('✗ ZEN CATALOGUE NEEDS A DECISION\n')
	if (undecided.length > 0) {
		console.error('  These models are documented and routed upstream, and are carried neither way:')
		for (const [id, why] of undecided) console.error(`    ${id} — ${why}`)
		console.error(
			'\n  Nothing is carried by default, because a model whose wire is not known cannot\n' +
				'  be routed. Either upstream supplies the missing half, or omit the model in\n' +
				`  ${REVIEW_REF} under \`omissions\` with a reason.`,
		)
	}
	if (stale.length > 0) {
		if (undecided.length > 0) console.error('')
		console.error('  These omissions no longer apply, because upstream neither documents nor serves them:')
		for (const id of stale) console.error(`    ${id}`)
		console.error(`\n  Remove them from ${REVIEW_REF}.`)
	}
	if (orphanPrices.length > 0) {
		if (undecided.length > 0 || stale.length > 0) console.error('')
		console.error('  These price rows name a model their own page does not route:')
		for (const name of orphanPrices) console.error(`    ${name}`)
		console.error(
			'\n  The page prices a model its route table does not list, so there is no wire to\n' +
				'  carry it on and the row is unused. Upstream has to resolve it; nothing here\n' +
				'  can, and nothing here silently ignores it either.',
		)
	}
	if (servedUncurried.length > 0) {
		if (undecided.length > 0 || stale.length > 0 || orphanPrices.length > 0) console.error('')
		console.error('  These ids are served by the service and are neither carried nor omitted:')
		for (const id of servedUncurried) console.error(`    ${id}`)
		console.error(
			'\n  The `/models` answer carries an id and nothing about how to call the model, so\n' +
				'  an id the pages do not document has no derivable wire and cannot be carried by\n' +
				'  guessing. Curate it: record the decision under `omissions` in\n' +
				`  ${REVIEW_REF} with the reason it is not carried, or have upstream\n` +
				'  document it so its route is stated. Until then a runtime catalogue lists it\n' +
				'  as having no known wire format, callable only with an explicit protocol.',
		)
	}
}

/** What this run would do to the roster, printed under whatever came before it. */
export function printChanges(committed, built) {
	for (const line of describeChanges(committed, built)) console.error(`  ${line}`)
}

/** The module a check compares against: the fixture's when `--from` holds one. */
function comparePath() {
	if (FROM_DIR !== undefined) {
		const candidate = join(FROM_DIR, 'models.ts')
		try {
			readFileSync(candidate)
			return candidate
		} catch {
			// No module beside these sources: fall back to the tree's.
		}
	}
	return OUTPUT_PATH
}

/** Render through the formatter, with a missing formatter reported as exit 2. */
function formatOrUnusable(source) {
	try {
		return formatted(source)
	} catch (error) {
		unusable(error)
	}
}

async function main() {
	const checking = process.argv.includes('--check')
	const against = comparePath()

	let onDisk
	try {
		onDisk = readFileSync(against, 'utf8')
	} catch {
		if (checking) {
			console.error(`${against} is missing. Run \`node scripts/generate-zen-models.mjs\` and commit it.`)
			process.exit(1)
		}
		onDisk = undefined
	}
	const committed = onDisk === undefined ? { zen: [], go: [] } : parseRendered(onDisk)

	let built
	let omissions
	try {
		const sources = await loadSources()
		omissions = readReview(reviewPath())
		// The same entry point the runtime refresh uses, measured against the
		// module on disk rather than the bundled snapshot it would default to.
		const { catalogue, report } = buildZenCatalogue(sources, { omissions, baseline: committed })
		built = {
			zen: catalogue.zen.map(comparable),
			go: catalogue.go.map(comparable),
			undecided: [...report.undecided],
			stale: [...report.stale],
			orphanPrices: [...report.orphanPrices],
			servedUncurried: [...report.servedUndocumented],
		}
	} catch (error) {
		unusable(error)
	}
	const omitted = Object.keys(omissions)

	// A decision about a model the derivation would have carried stops the write:
	// writing the roster without it would encode the decision as a silent
	// omission. The roster changes are printed WITH it, whatever the exit code.
	const blocking = built.undecided.length + built.stale.length + built.orphanPrices.length > 0
	if (blocking) {
		printDecisions(built)
		printChanges(committed, built)
		process.exit(1)
	}

	// The refresh date is provenance, not a claim about upstream, so the check
	// compares everything except that one line. Rendering under the date the
	// module ALREADY carries is what makes a refresh that found nothing new
	// write nothing and leave the date where it was.
	const carriedDate = onDisk?.match(/^ \* Refreshed: (.+)$/m)?.[1] ?? '(unrecorded)'
	const expected = formatOrUnusable(render(built, carriedDate, omitted))

	if (onDisk !== undefined && onDisk === expected) {
		// The served roster is the one thing that can be wrong while every byte of
		// the module is right, so it is reported on the agreement path too.
		if (built.servedUncurried.length > 0) {
			printDecisions(built)
			process.exit(1)
		}
		console.log(`zen catalogue matches its source: ${built.zen.length} zen, ${built.go.length} go`)
		process.exit(0)
	}

	if (!checking) {
		// A refresh stamps the day the ROSTER moved, not the day somebody asked.
		const rendered = formatOrUnusable(render(built, localDate(new Date()), omitted))
		writeFileSync(OUTPUT_PATH, rendered)
		const total = built.zen.length + built.go.length
		console.log(`models.ts written: ${built.zen.length} zen, ${built.go.length} go (${total} models)`)
		for (const line of describeChanges(committed, built)) console.log(`  ${line}`)
		// An id served and documented nowhere is written to nothing — the derived
		// roster is unaffected by it — so the module is still written and the run
		// still exits 1: whoever reads the diff has a decision to make.
		if (built.servedUncurried.length > 0) {
			console.log('')
			printDecisions(built)
			process.exit(1)
		}
		process.exit(0)
	}

	const actual = onDisk.split('\n')
	const expectedLines = expected.split('\n')
	const firstDifference = expectedLines.findIndex((line, index) => line !== actual[index])

	console.error('✗ ZEN CATALOGUE DRIFT\n')
	console.error('  packages/providers/zen/src/models.ts is not what upstream documents today.')
	for (const line of describeChanges(committed, built)) console.error(`  ${line}`)
	console.error(`\n  First difference at line ${firstDifference + 1}:`)
	console.error(`    on disk:  ${JSON.stringify(actual[firstDifference] ?? '<end of file>')}`)
	console.error(`    expected: ${JSON.stringify(expectedLines[firstDifference] ?? '<end of file>')}`)
	console.error(
		'\n  Upstream has moved — most often because it added or repriced a model. To refresh\n' +
			'  the bundled snapshot:\n' +
			'    node scripts/generate-zen-models.mjs\n' +
			'  then review the diff and commit it. Never edit models.ts by hand: the next\n' +
			'  regeneration discards it.',
	)
	if (built.servedUncurried.length > 0) {
		console.error('')
		printDecisions(built)
	}
	process.exit(1)
}

// Runs only when this file is invoked directly, not when it is imported: the
// test suite imports the helpers above, and a bare import must not fetch,
// render, write or call `process.exit`.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
// Not `await main()`: the test runner loads this file through tsx, which
// transpiles to CommonJS, where top-level await does not parse.
if (isMain) {
	main().catch((error) => {
		console.error(error)
		process.exit(1)
	})
}
