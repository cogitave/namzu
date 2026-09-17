#!/usr/bin/env node
/**
 * Derive the pinned Zen catalogue from the documents that define it.
 *
 *   node scripts/generate-zen-models.mjs            # fetch upstream, rewrite models.ts
 *   node scripts/generate-zen-models.mjs --check    # fetch upstream, diff, exit 1 on drift
 *   node scripts/generate-zen-models.mjs --from DIR # read the SOURCES from DIR instead of
 *                                                   # the network — the two pages, the
 *                                                   # models.dev document, the two /models
 *                                                   # answers, DIR/models.review.json and
 *                                                   # DIR/models.ts, each when it is there
 *
 * Exit codes: 0 in agreement, 1 a decision somebody has to make — the module
 * disagrees with its sources, or a source names a model the catalogue neither
 * carries nor omits — and 2 a source could not be read, no longer has the shape
 * this script parses, or the formatter it renders through is not installed. The
 * distinction is the one a reader needs at 2am: 1 is a decision somebody has to
 * make, 2 is a source that moved and no edit to models.ts will fix.
 *
 * ## Why this one fetches where the price catalogue does not
 *
 * scripts/generate-model-prices.mjs reads a reviewed table out of the tree,
 * because a rate is a commercial fact and two builds of one commit must agree
 * about it. A model ROSTER is the opposite kind of thing: its defect is going
 * stale, and a gate that cannot see upstream can only ever report that a file
 * equals itself. So the sources are the live documents and the gate is a
 * network gate. It fails rather than skipping when they are unreachable,
 * because "I could not look" reported as "this is fine" is the failure the
 * optional-dependency rule exists to prevent.
 *
 * What is NOT fetched is anything a consumer depends on at run time. models.ts
 * is ordinary committed code; the network is reached by this script and never
 * by the driver, the SDK or the CLI.
 *
 * ## The third source: what the service actually serves
 *
 * The pages can only be as current as whoever edits them, and the service
 * serves ids they do not document — measured 2026-09-18: the Zen `/models`
 * answer carried 71 ids and its page documented 70, and three of the Zen ids
 * and nine of the Go ids were on neither page nor in the review file. A roster
 * gate that reads only the pages cannot see them, and `listModels()` drops what
 * it does not know, so the model the owner was told about never arrives. So
 * `--check` also reads the two `/models` answers and reports every id served
 * but neither carried nor omitted. That answer carries `id`, `object`,
 * `created` and `owned_by` and nothing else, so it says a model EXISTS and
 * nothing about how to call it: such an id cannot be carried, only curated,
 * which is why it is exit 1 and why the remedy is a review-file entry.
 *
 * An unreachable or unreadable `/models` is exit 2 like any other source, and
 * never a silent pass: "I could not look" reported as "this is fine" is the
 * failure the whole optional-dependency rule exists to prevent. The two
 * endpoints answer anonymously, from CI as from a laptop, which is why a
 * scheduled run can read them at all.
 *
 * ## Where each field comes from
 *
 * Routes come from the service's own documentation page, as the pair
 * (endpoint, AI SDK package) that page states per model. Both halves are read
 * and required to agree, because a page that changed shape must stop the run
 * rather than have one half guessed: the wire a model is served on is a
 * routing fact, and the wrong one is a request to the wrong endpoint rather
 * than a clean failure.
 *
 * Prices come from the same page's per-1M-token table, at the base tier: the
 * unqualified row when a model has one, the "(Off-Peak)" row for the Go
 * DeepSeek entries that publish both, and the "(≤ n tokens)" row when a model
 * is only published as a tier pair. A model with no price row at all must
 * appear in that page's free-model list and is then zero — "no row" is never
 * quietly read as free.
 *
 * Limits, modalities, tool support and effort levels come from the matching
 * provider entry in models.dev, which is where the upstream project keeps
 * them. Its `npm` is deliberately NOT used as a route, in either of the two
 * places models.dev states one: the provider-level field names a single
 * Chat-Completions package for both services, which would send the Go Qwen
 * rows — documented on `/messages` — to `/chat/completions`, and the per-model
 * `provider.npm` is stated for fewer than half the documented models, so it
 * cannot route the rest. A runtime that trusted either would route some models
 * to the wrong endpoint.
 *
 * ## What is curated, and what happens when upstream adds a model
 *
 * Everything above is derived, so a new upstream model reaches the catalogue
 * only once a maintainer runs the command at the top. That is deliberate — the
 * wire is a routing fact and a wrong route is a wrong request — but it means
 * the failure mode is silence, so a model a source names must be either CARRIED
 * or OMITTED with a reason in models.review.json, and the gate fails on any
 * documented model that is neither, naming every one of them. Nothing is
 * skipped quietly, and nothing is defaulted.
 *
 * An id the service serves and the pages do not document is in the same
 * position for a different reason: there is no route to derive, so it cannot be
 * carried, and it is exit 1 in both modes until somebody records the decision.
 * A refresh still WRITES while one of those stands — the roster it derives is
 * unaffected — so that the diff a reviewer is looking at and the list of ids
 * that need curating arrive together. The scheduled workflow
 * (.github/workflows/zen-catalogue-refresh.yml) is built on exactly that: it
 * opens a pull request when the module moved, with this script's own report in
 * the body, and fails loudly when the service moved and the module did not.
 *
 * Omissions expire in the same direction: an entry naming a model upstream
 * neither documents nor serves fails the gate too, so the review file cannot
 * accumulate decisions about models nobody serves.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ZEN_DIR = join(HERE, '..', 'packages', 'providers', 'zen')
const OUTPUT_PATH = join(ZEN_DIR, 'src', 'models.ts')
const REVIEW_PATH = join(ZEN_DIR, 'src', 'models.review.json')
const REVIEW_REF = 'packages/providers/zen/src/models.review.json'

/**
 * `--from DIR` replaces every source this script reads, including the review
 * file. That is what makes the offline mode a COMPLETE reproduction rather
 * than a partial one: a run that took its pages from a directory but its
 * curation decisions from the working tree would answer a question nobody
 * asked, and the test suite would have to write to the real review file to
 * exercise anything.
 */
const FROM_DIR = (() => {
	const index = process.argv.indexOf('--from')
	// An empty string rather than undefined when the flag is given without a
	// value, so `--from` on its own fails instead of quietly fetching.
	return index === -1 ? undefined : (process.argv[index + 1] ?? '')
})()

/** The branch to read the service's documentation from. `dev` is its default. */
const DOCS_REF = process.env.NAMZU_ZEN_DOCS_REF ?? 'dev'
const DOCS_BASE = `https://raw.githubusercontent.com/anomalyco/opencode/${DOCS_REF}/packages/web/src/content/docs`
const MODELS_DEV_URL = 'https://models.dev/api.json'
/**
 * The host the two services' own `/models` endpoints hang off.
 *
 * Overridable for the same reason `NAMZU_ZEN_DOCS_REF` is: the served roster is
 * a source like any other, and a test that wants to drive the fetch without the
 * network — or an operator pointing the run at a mirror — needs a seam that is
 * not a code change. Pointing it at a host that does not answer is a source
 * failure (exit 2), never a run that checked nothing.
 */
const SERVICE_BASE = (process.env.NAMZU_ZEN_MODELS_BASE ?? 'https://opencode.ai').replace(/\/+$/, '')
const FETCH_TIMEOUT_MS = 30_000
const FETCH_ATTEMPTS = 3

/** A service, its documentation page, and the models.dev provider holding its limits. */
const SERVICES = [
	{ service: 'zen', page: 'zen.mdx', provider: 'opencode' },
	{ service: 'go', page: 'go.mdx', provider: 'opencode-go' },
]

/**
 * Every (AI SDK package, endpoint) pair a page may state, and the protocol
 * each is. `kind` says how the endpoint names the model: the first three put
 * it in the body of a fixed path, Google puts it in the path itself.
 */
export const ROUTES = [
	{ npm: '@ai-sdk/openai-compatible', path: '/chat/completions', protocol: 'chat', kind: 'path' },
	{ npm: '@ai-sdk/openai', path: '/responses', protocol: 'responses', kind: 'path' },
	{ npm: '@ai-sdk/anthropic', path: '/messages', protocol: 'messages', kind: 'path' },
	{ npm: '@ai-sdk/google', path: '/models/', protocol: 'google', kind: 'model' },
]

/** The Google route's tail: `models/<id>`, and nothing else. */
const MODEL_PATH = /^models\/[a-z0-9][a-z0-9.-]*$/

/** The SDK's input modalities, and the models.dev names that map onto them. */
export const MODALITIES = { text: 'text', image: 'image', pdf: 'document' }

class UnusableSourceError extends Error {}

function unusable(error) {
	const detail = error instanceof Error ? error.message : String(error)
	console.error('✗ ZEN CATALOGUE SOURCE UNUSABLE\n')
	console.error(`  ${detail}`)
	console.error(
		'\n  This is not drift in packages/providers/zen/src/models.ts, and editing that\n' +
			'  file will not clear this. One of three things happened: the network to an\n' +
			'  upstream source is down, a source changed shape and this script no longer\n' +
			'  reads it correctly, or the formatter the script renders through is not\n' +
			'  installed. Run `pnpm install` if you have not.',
	)
	process.exit(2)
}

async function fetchText(url) {
	let lastError
	for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
		try {
			const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
			if (response.ok) return await response.text()
			// A 404 is a branch or a path that moved. Retrying cannot fix it, and
			// reporting it as a flaky network would hide the actual cause.
			if (response.status === 404) {
				throw new UnusableSourceError(`${url} answered 404 — the branch or the path moved.`)
			}
			throw new Error(`${url} answered ${response.status}.`)
		} catch (error) {
			if (error instanceof UnusableSourceError) throw error
			lastError = error
			if (attempt < FETCH_ATTEMPTS) {
				await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
			}
		}
	}
	throw new UnusableSourceError(
		`${url} could not be read after ${FETCH_ATTEMPTS} attempts: ${
			lastError instanceof Error ? lastError.message : String(lastError)
		}`,
	)
}

/**
 * A directory as a source, with every file it names required to be there.
 *
 * An empty `--from` fails rather than quietly fetching, and a missing file is
 * named: a run that took some of its sources from a directory and quietly got
 * the rest from the network would answer a question nobody asked.
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

/** The three upstream documents, from the network or from a cached directory. */
async function loadSources() {
	if (FROM_DIR !== undefined) {
		const read = requiredReader(FROM_DIR)
		return {
			docs: { zen: read('zen.mdx'), go: read('go.mdx') },
			modelsDev: JSON.parse(read('models.dev.json')),
		}
	}
	const [zen, go, modelsDev] = await Promise.all([
		fetchText(`${DOCS_BASE}/zen.mdx`),
		fetchText(`${DOCS_BASE}/go.mdx`),
		fetchText(MODELS_DEV_URL),
	])
	return { docs: { zen, go }, modelsDev: JSON.parse(modelsDev) }
}

/**
 * The two `/models` answers: what each service says it serves right now.
 *
 * From a directory when `--from` names one that holds them, and from the
 * service otherwise — the same "when they are there" rule the module and the
 * review file already follow under `--from`, so a test can pin the served
 * roster beside the pages it belongs with and a run without them still asks the
 * service. A fixture directory that omits them is therefore NOT offline for
 * this dimension; the test that drives the fetch points NAMZU_ZEN_MODELS_BASE at
 * a server it owns instead.
 */
async function loadServed() {
	if (FROM_DIR !== undefined) {
		const read = (name) => {
			try {
				return readFileSync(join(FROM_DIR, name), 'utf8')
			} catch {
				return undefined
			}
		}
		const [zen, go] = [read(SERVED_FILE.zen), read(SERVED_FILE.go)]
		if (zen !== undefined && go !== undefined) {
			return { zen: parseServed('zen', zen), go: parseServed('go', go) }
		}
	}
	const [zen, go] = await Promise.all([
		fetchText(servedUrl('zen')),
		fetchText(servedUrl('go')),
	])
	return { zen: parseServed('zen', zen), go: parseServed('go', go) }
}

/** The models-list endpoint of one service, on the base this run is reading. */
function servedUrl(service) {
	return `${SERVICE_BASE}${SERVICE_PREFIX[service]}models`
}

/**
 * One `/models` answer, as the set of ids it says the service serves.
 *
 * The shape is asserted rather than assumed, and an answer with no ids in it is
 * refused: a service that returns nothing is a source that moved, and reading
 * it as "nothing is served" would turn an outage into a green run over a gate
 * that just stopped checking anything.
 */
export function parseServed(service, text) {
	let body
	try {
		body = JSON.parse(text)
	} catch (error) {
		throw new UnusableSourceError(
			`The ${service} /models answer is not JSON: ${error instanceof Error ? error.message : error}`,
		)
	}
	if (!Array.isArray(body?.data)) {
		throw new UnusableSourceError(
			`The ${service} /models answer has no \`data\` array. It is the field this script\n` +
				'  reads the served roster from, so a service that changed shape stops here.',
		)
	}
	const ids = new Set()
	for (const item of body.data) {
		if (!item || typeof item !== 'object' || typeof item.id !== 'string' || item.id.length === 0) {
			throw new UnusableSourceError(
				`The ${service} /models answer has an entry with no string \`id\`. Every id it\n` +
					'  serves is checked against the catalogue, so an entry that cannot be read is\n' +
					'  an id nobody checked.',
			)
		}
		ids.add(item.id)
	}
	if (ids.size === 0) {
		throw new UnusableSourceError(
			`The ${service} /models answer lists no models at all. That is a source that moved,\n` +
				'  not a service that serves nothing, and accepting it would make this check\n' +
				'  decorative for as long as the outage lasted.',
		)
	}
	return ids
}

/**
 * Whether a line looks like a row of the route table.
 *
 * The account has to CLOSE, not merely to be attempted: a line shaped like a
 * route row that the route pattern did not capture is a page this script no
 * longer reads correctly, and dropping it silently is the defect the whole
 * arrangement exists to remove. Two shapes count, and both were measured
 * against the live pages rather than guessed — today they flag nothing there:
 *
 *  - two or more backticked cells, which is a row carrying both its endpoint
 *    and its package;
 *  - three or more cells with at least one backticked cell, which is a row that
 *    kept a value and lost a column: an empty package cell leaves four cells,
 *    and a row whose package COLUMN is gone leaves three, with the endpoint's
 *    backticks and nothing else. Three rather than four because that second
 *    shape used to pass here in silence — measured, a three-cell row carrying
 *    one code span is read by this script as nothing at all, so the gate
 *    reported agreement while the page documented a model that was neither
 *    carried nor omitted.
 *
 * The backtick guard is what keeps the wider rule off the table separators:
 * `| --- | --- | --- | --- |` is four cells and carries no code span, and the
 * live pages have two of them per table. Measured on 2026-09-18 with the wider
 * rule, both pages flag zero lines.
 *
 * A prose row that happens to quote a code span is not either: measured, the
 * Go page has exactly one such row and it has two cells.
 */
export function isRouteRowShaped(line) {
	const ticked = [...line.matchAll(/`[^`]*`/g)].length
	const cells = line.split('|').length - 2
	return ticked >= 2 || (cells >= 3 && ticked >= 1)
}

/** A documentation page, split into the three tables this script reads. */
export function parsePage(text, { page, service }) {
	const routes = []
	const prices = []
	const freeNames = []
	const unroutable = []
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
			if (bullet) {
				freeNames.push(bullet[1].trim())
				continue
			}
			if (line.trim().length > 0 && !line.startsWith('-')) inFreeSection = false
		}
		const route = line.match(
			/^\|\s*(.+?)\s*\|\s*([a-z0-9][a-z0-9.\-]*)\s*\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|$/,
		)
		if (route) {
			routes.push({ name: route[1].trim(), id: route[2], endpoint: route[3], npm: route[4] })
			continue
		}
		const price = line.match(/^\|\s*(.+?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|/)
		if (price) {
			// A price cell is a dollar figure or the word "Free". Nothing else is
			// read, so a table whose columns mean something else cannot be picked
			// up by being three cells wide.
			const input = priceCell(price[2])
			const output = priceCell(price[3])
			if (input !== undefined && output !== undefined) {
				prices.push({ name: price[1].trim(), input, output })
				continue
			}
		}
		if (line.startsWith('|') && isRouteRowShaped(line)) unroutable.push(line.trim())
	}
	if (unroutable.length > 0) {
		throw new UnusableSourceError(
			`${page} has ${unroutable.length} line(s) shaped like a route row that this script\n` +
				'  did not read as one. A model the page routes but this script does not capture is\n' +
				'  a model that silently disappears from the catalogue, so the run stops instead:\n' +
				unroutable
					.slice(0, 5)
					.map((line) => `    ${line}`)
					.join('\n') +
				(unroutable.length > 5 ? `\n    … and ${unroutable.length - 5} more` : ''),
		)
	}
	if (routes.length === 0) throw new UnusableSourceError(`${page} has no route table.`)
	if (service === 'zen' && freeNames.length === 0) {
		throw new UnusableSourceError(
			`${page} has no free-model list. Anonymous admission is stated there and is never\n` +
				'  inferred from a zero price, so an empty list is a page that moved, not a\n' +
				'  catalogue that serves nothing for free.',
		)
	}
	return { routes, prices, freeNames }
}

/**
 * A price cell, or undefined when the cell is not a price.
 *
 * Go states its free models' rate as the word "Free" rather than as `$0.00`,
 * which is a statement about the price and not a missing one, so it is read as
 * zero. A cell that is neither a dollar figure nor "Free" is not a price at
 * all, which is what keeps an unrelated three-column table from being read as
 * one.
 */
export function priceCell(cell) {
	const dollars = /^\$([0-9.]+)$/.exec(cell.trim())
	if (dollars) return Number(dollars[1])
	return /^free$/i.test(cell.trim()) ? 0 : undefined
}

/** Model names are matched across tables by their letters, digits and dots. */
export function nameKey(name) {
	return name
		.toLowerCase()
		.replace(/\([^)]*\)/g, '')
		.replace(/[^a-z0-9.]/g, '')
}

/**
 * The base-tier price row for a model.
 *
 * Three shapes appear upstream: a single row, a tier pair separated by a
 * parenthesised context threshold, and the Go DeepSeek entries' peak/off-peak
 * pair. The base tier is the cheap one in each case: the unqualified row, the
 * "(≤ …)" row, or the "(Off-Peak)" row.
 */
export function priceRowFor(rows, name) {
	const candidates = rows.filter((row) => nameKey(row.name) === nameKey(name))
	if (candidates.length === 0) return undefined
	return (
		candidates.find((row) => /off-peak/i.test(row.name)) ??
		candidates.find((row) => !row.name.includes('(')) ??
		candidates.find((row) => row.name.includes('≤'))
	)
}

/** The service each base host serves, by the path prefix its endpoints carry. */
const SERVICE_PREFIX = { zen: '/zen/v1/', go: '/zen/go/v1/' }

/** The file each service's `/models` answer is cached as under `--from`. */
const SERVED_FILE = { zen: 'served.zen.json', go: 'served.go.json' }

/**
 * The protocol a (package, endpoint) pair is, refusing anything unrecognised.
 *
 * The pair is checked against the URL's own parts rather than by substring: a
 * cell reading `https://evil.example/messages` contains the path a Messages
 * route has, and a routing decision that accepts it is a routing decision made
 * on the wrong string. Host, service prefix, path and package must all agree.
 */
export function protocolFor({ id, endpoint, npm }, service) {
	const refuse = (why) => {
		throw new UnusableSourceError(
			`"${id}" is documented as ${npm} on ${endpoint}, ${why}. A model whose wire is not\n` +
				'  known cannot be routed, so the run stops rather than picking one.',
		)
	}
	let url
	try {
		url = new URL(endpoint)
	} catch {
		refuse('which is not a URL')
	}
	if (url.host !== 'opencode.ai') refuse("whose host is not the service's")
	const prefix = SERVICE_PREFIX[service]
	if (prefix === undefined) refuse(`on a service this script does not know`)
	if (!url.pathname.startsWith(prefix)) refuse(`which is not on the ${service} service's own path`)
	const route = ROUTES.find((candidate) => candidate.npm === npm)
	if (!route) {
		refuse(`with a package that is not one of the ${ROUTES.length} routes this driver implements`)
	}
	const tail = url.pathname.slice(prefix.length)
	const matches = route.kind === 'path' ? tail === route.path.slice(1) : MODEL_PATH.test(tail)
	if (!matches) refuse(`which does not address ${route.path} on the ${service} service`)
	return route.protocol
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
 * question "does this still match upstream". Folding them together would make
 * the gate red on a tree nobody had touched since yesterday, and it would make
 * every scheduled run restamp the file and open a pull request about a date.
 * So a refresh that finds nothing new writes nothing at all.
 */
function header(refreshed) {
	return `/*
 * GENERATED FILE — do not edit. Regenerate with:
 *
 *   node scripts/generate-zen-models.mjs
 *
 * A curation decision is an edit to src/models.review.json, and how a field is
 * derived is an edit to the script. Both survive regeneration; a hand edit here
 * does not, and the CI gate "Zen catalogue matches its source" fails on one.
 *
 * Refreshed: ${refreshed}
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
 * src/models.review.json — and the CI gate fails on any documented model that
 * is neither carried nor omitted, so a new upstream model is a decision someone
 * makes rather than a row that arrives by itself. The gate also reads what the
 * two services' own \`/models\` answers say they serve: an id served and
 * documented nowhere has no derivable wire, so it is reported as a decision
 * too, rather than dropped by the driver in silence.
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

export function render(models, refreshed) {
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

/**
 * One service's carried models, plus everything either source names and the
 * catalogue does not carry: the models the page documents and this run did not
 * carry (`undecided`), the omissions the page no longer justifies (`stale`),
 * the price rows no route row names (`orphanPrices`), and the ids the service
 * itself serves that are neither carried nor omitted (`servedUncurried`).
 *
 * `served` is the set of ids the service's own `/models` answer carries, and it
 * is required rather than defaulted: a caller that forgot it would turn the
 * served dimension off silently, which is the class of defect the whole review
 * file exists to remove.
 */
export function derive(service, parsed, providerKey, provider, omissions, served) {
	const freeIds = new Set()
	for (const name of parsed.freeNames) {
		const row = parsed.routes.find((candidate) => nameKey(candidate.name) === nameKey(name))
		if (!row) {
			throw new UnusableSourceError(
				`The free-model list names "${name}", which the route table does not. Anonymous\n` +
					'  admission is derived from that pairing, so the page has moved.',
			)
		}
		freeIds.add(row.id)
	}
	const documented = new Set(parsed.routes.map((row) => row.id))
	// A price row the route table does not name is a model priced and not
	// routed. Nothing carries it, so it is reported rather than dropped.
	const routeNames = new Set(parsed.routes.map((row) => nameKey(row.name)))
	const orphanPrices = parsed.prices
		.filter((row) => !routeNames.has(nameKey(row.name)))
		.map((row) => row.name)
	const models = []
	const undecided = []
	const incomplete = []
	// How many rows were actually put to models.dev, which is what "all of
	// them" has to mean: an omitted row is never asked about.
	let considered = 0
	// Of those, the ones whose models.dev entry exists but does not say whether
	// the model takes tools. Read as a count rather than a boolean because the
	// tell is "every one of them", and one model of many is a real answer.
	let silentOnTools = 0
	// The entries models.dev actually has, which is the denominator the
	// tool-support tell below has to use.
	let modelsDevEntries = 0
	for (const row of parsed.routes) {
		if (omissions[`${service}/${row.id}`] !== undefined) continue
		considered += 1
		const metadata = provider.models[row.id]
		if (!metadata) {
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
		const effort = (metadata.reasoning_options ?? []).find((option) => option.type === 'effort')
		const inputModalities = (metadata.modalities?.input ?? [])
			.map((modality) => MODALITIES[modality])
			.filter((modality) => modality !== undefined)
		const contextWindow = metadata.limit?.context
		const maxOutputTokens = metadata.limit?.output
		if (contextWindow === undefined || maxOutputTokens === undefined || inputModalities.length === 0) {
			incomplete.push(
				`${service}/${row.id} (context ${contextWindow}, output ${maxOutputTokens}, ` +
					`${inputModalities.length} input modalities)`,
			)
			continue
		}
		models.push({
			id: row.id,
			name: row.name,
			protocol: protocolFor(row, service),
			contextWindow,
			maxOutputTokens,
			inputModalities,
			inputPrice: priceRow?.input ?? 0,
			outputPrice: priceRow?.output ?? 0,
			supportsToolUse: metadata.tool_call === true,
			effortLevels: effort ? [...effort.values] : [],
			// Anonymous admission is a Zen concept: the Go constructor refuses an
			// absent key outright, so the flag would mean nothing on that service.
			supportsAnonymousAccess: service === 'zen' && freeIds.has(row.id),
		})
	}
	// Incomplete metadata is a source that moved, not a decision anybody makes.
	// A missing entry is a decision — omit the model — but an entry that is
	// there and has lost the fields is models.dev having changed shape, and
	// every model reporting it at once is exactly what a rename looks like.
	if (incomplete.length > 0) {
		const all = incomplete.length === considered
		throw new UnusableSourceError(
			`${incomplete.length}${all ? ' — every documented —' : ` of ${considered}`} model(s) on the\n` +
				`  ${service} page have an entry in models.dev that is missing the fields the catalogue\n` +
				'  needs. An entry that exists and has lost its limits is models.dev having changed\n' +
				'  shape, not a curation decision, so this is reported as drift in the SOURCE:\n' +
				incomplete
					.slice(0, 8)
					.map((line) => `    ${line}`)
					.join('\n') +
				(incomplete.length > 8 ? `\n    … and ${incomplete.length - 8} more` : ''),
		)
	}
	// `tool_call` is the third field whose loss has to be read as a source that
	// moved. It is the one that fails QUIETLY: the other fields being missing
	// leaves a model `incomplete` and is reported, where a missing `tool_call`
	// reads as "this model takes no tools", so a renamed field would rewrite the
	// whole roster to `supportsToolUse: false`, print a drift report with "run
	// the generator" as its remedy, and go green when somebody did. Every entry
	// at once is a rename; one entry is a real answer, and is carried as false.
	if (modelsDevEntries > 0 && silentOnTools === modelsDevEntries) {
		throw new UnusableSourceError(
			`All ${modelsDevEntries} models.dev entr${modelsDevEntries === 1 ? 'y' : 'ies'} for the ${service}\n` +
				'  provider omit `tool_call`. A field that vanished from every entry at once is models.dev\n' +
				'  having changed shape, not every model losing its tools, so this is reported as a\n' +
				'  SOURCE failure rather than written into the catalogue as `supportsToolUse: false`.',
		)
	}
	// The ids the service serves that this service's page does not document and
	// the review file does not omit. They cannot be carried — an id whose wire
	// is not stated cannot be routed — so they are a curation decision.
	const servedUncurried = [...served]
		.filter((id) => !documented.has(id) && omissions[`${service}/${id}`] === undefined)
		.sort()
	// An omission expires when upstream stops naming the model at all, which now
	// means neither its page nor the service that serves it: the page is not the
	// only source that says a model exists.
	const stale = Object.keys(omissions)
		.filter((key) => key.startsWith(`${service}/`))
		.map((key) => key.slice(service.length + 1))
		.filter((id) => !documented.has(id) && !served.has(id))
	return { models, undecided, stale, orphanPrices, servedUncurried }
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
 * Read back a generated module, so a run can say what changed rather than
 * only that something did.
 *
 * It parses the shape `renderEntry` writes, which is legitimate precisely
 * because that shape is generated: a file that has been hand-edited into
 * another shape is caught by the byte comparison that runs after this, and
 * this only has to be good enough to name the models.
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
			// come back single-quoted from disk, because the formatter the render
			// runs through rewrites the quotes. Reading the value, not the
			// spelling, so that a module read back before formatting and one read
			// after both parse.
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
	for (const { service } of SERVICES) {
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
 * Refuse a roster that collapsed.
 *
 * Exit 1 says "a person has to decide", and a decision is something a person
 * can make. A roster that came out empty, or that lost a fifth of what it
 * carried, is not that: it is a source that moved, or a review file that has
 * been used to delete the catalogue, and both of them look identical to a
 * successful run from the inside. The floor is stated rather than implied, and
 * it is a speed bump on purpose — if upstream really did withdraw that many
 * models, this number is the thing to change, and changing it is a decision
 * somebody makes rather than one they discover afterwards.
 */
const ROSTER_FLOOR = 0.8

export function checkRosterFloor(built, committed) {
	for (const { service } of SERVICES) {
		const derived = built[service].length
		const carried = committed[service].length
		if (derived === 0) {
			throw new UnusableSourceError(
				`The ${service} roster came out empty. Every documented model was rejected — a\n` +
					'  catalogue with nothing in it is not a result, and a review file that omits\n' +
					'  every model produces exactly this. Refusing rather than writing it.',
			)
		}
		if (carried > 0 && derived < carried * ROSTER_FLOOR) {
			throw new UnusableSourceError(
				`The ${service} roster fell from ${carried} models to ${derived}, past the floor of\n` +
					`  ${ROSTER_FLOOR * 100}% of what is committed. A fall that size is far more likely to be a source\n` +
					'  that changed shape than a decision somebody made, so it is reported as one.\n' +
					'  If upstream really did withdraw that many models, change ROSTER_FLOOR in this\n' +
					'  script and say so in the commit.',
			)
		}
	}
}

/**
 * Everything this run needs somebody to decide, printed as one report.
 *
 * Four sections, one line per thing. The fourth is the one the pages cannot
 * speak for: an id the service answers on `/models` that no page documents and
 * no omission covers. It is exit 1 like the rest — it is a decision, and the
 * script cannot make it, because the wire a model is served on is stated on a
 * page and nowhere else.
 *
 * Prints nothing when there is nothing to decide, so a caller can hand it the
 * whole derivation and let it decide whether it has anything to say.
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
				'  document it so its route is stated. A model the service serves and the\n' +
				'  catalogue neither carries nor omits is one the driver will never offer,\n' +
				'  however new it is.',
		)
	}
}

/** What this run would do to the roster, printed under whatever came before it. */
export function printChanges(committed, built) {
	for (const line of describeChanges(committed, built)) console.error(`  ${line}`)
}

/**
 * The module a check compares against, and a refresh reports its changes
 * against.
 *
 * `--from` replaces this too when the directory holds one, for the reason it
 * replaces the review file: a run that took its pages from a directory but its
 * baseline from the working tree would answer a question nobody asked, and the
 * offline mode would be unable to exercise the two things this gate is for —
 * agreeing, and disagreeing with a stated reason. A refresh still WRITES to
 * the real module; only what it reads moves.
 */
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

/**
 * Render through the formatter, with a formatter that is not there reported as
 * the source failure it is.
 *
 * `biomeEntryPoint()` throws an `UnusableSourceError` like any other missing
 * source, and it used to do it OUTSIDE every catch — so a tree without
 * `node_modules` printed a raw stack from `main().catch` and exited 1, which is
 * the code that means "a person has to decide". Nobody can decide their way out
 * of a missing binary, and the file's own contract says so.
 */
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
	try {
		const sources = await loadSources()
		const served = await loadServed()
		const omissions = readReview(reviewPath())
		built = { zen: [], go: [], undecided: [], stale: [], orphanPrices: [], servedUncurried: [] }
		for (const { service, page, provider } of SERVICES) {
			const parsed = parsePage(sources.docs[service], { page, service })
			const entry = sources.modelsDev[provider]
			if (!entry?.models) {
				throw new UnusableSourceError(`models.dev has no \`${provider}\` provider entry.`)
			}
			const derived = derive(service, parsed, provider, entry, omissions, served[service])
			built[service] = derived.models
			built.undecided.push(...derived.undecided)
			built.stale.push(...derived.stale)
			built.orphanPrices.push(...derived.orphanPrices.map((name) => `${service}: ${name}`))
			built.servedUncurried.push(...derived.servedUncurried.map((id) => `${service}/${id}`))
		}
		checkRosterFloor(built, committed)
	} catch (error) {
		unusable(error)
	}

	// A decision about a model the derivation would have carried stops the write:
	// writing the roster without it would encode the decision as a silent
	// omission. The roster changes are printed WITH it, whatever the exit code —
	// a run that stopped at the decision used to report nothing about what
	// upstream had done, which reads as "no news" when it is the opposite.
	const blocking = built.undecided.length + built.stale.length + built.orphanPrices.length > 0
	if (blocking) {
		printDecisions(built)
		printChanges(committed, built)
		process.exit(1)
	}

	// The refresh date is provenance, not a claim about upstream, so the check
	// compares everything except that one line. Rendering under the date the
	// module ALREADY carries is what makes the comparison "is this file what the
	// generator produces?" — and it is why a refresh that found nothing new
	// writes nothing and leaves the date where it was.
	const carriedDate = onDisk?.match(/^ \* Refreshed: (.+)$/m)?.[1] ?? '(unrecorded)'
	const expected = formatOrUnusable(render(built, carriedDate))

	if (onDisk !== undefined && onDisk === expected) {
		// The served roster is the one thing that can be wrong while every byte of
		// the module is right, so it is reported on the agreement path too — and
		// instead of the all-clear, which would otherwise be the last thing a
		// reader saw before an exit 1.
		if (built.servedUncurried.length > 0) {
			printDecisions(built)
			process.exit(1)
		}
		console.log(`zen catalogue matches its source: ${built.zen.length} zen, ${built.go.length} go`)
		process.exit(0)
	}

	if (!checking) {
		// A refresh stamps the day the ROSTER moved, not the day somebody asked.
		// The date line is why: stamping today on a run that changed nothing would
		// put a diff under review on every scheduled run.
		const rendered = formatOrUnusable(render(built, localDate(new Date())))
		writeFileSync(OUTPUT_PATH, rendered)
		const total = built.zen.length + built.go.length
		console.log(`models.ts written: ${built.zen.length} zen, ${built.go.length} go (${total} models)`)
		// A refresh states what it did to the roster, removals included. A model
		// that disappears quietly is the defect this whole arrangement is for.
		for (const line of describeChanges(committed, built)) console.log(`  ${line}`)
		// An id served and documented nowhere is written to nothing — the derived
		// roster is unaffected by it — so the module is still written and the run
		// still exits 1: whoever reads the diff has a decision to make, and the
		// scheduled workflow that consumes this prints the list into its PR.
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
		'\n  Upstream has moved — most often because it added or repriced a model, which is\n' +
			'  the defect this gate exists to make loud. To refresh:\n' +
			'    node scripts/generate-zen-models.mjs\n' +
			'  then review the diff and commit it. Never edit models.ts by hand: the next\n' +
			'  regeneration discards it.',
	)
	// Both, always: the drift above is what the gate is named for, and the
	// decision below is why the refresh that remedy names would refuse to write.
	// Reporting only the second was the defect; reporting only the first is the
	// opposite one.
	if (built.servedUncurried.length > 0) {
		console.error('')
		printDecisions(built)
	}
	process.exit(1)
}

// Runs the CLI only when this file is invoked directly
// (`node scripts/generate-zen-models.mjs`), not when it is imported. The test
// suite imports the pure helpers above against synthetic pages; a bare import
// must not fetch, render, write or call `process.exit`.
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
// Not `await main()`: the test runner loads this file through tsx, which
// transpiles to CommonJS, where top-level await does not parse. A rejection
// that reached the top would otherwise be an unhandled one and exit zero.
if (isMain) {
	main().catch((error) => {
		console.error(error)
		process.exit(1)
	})
}
