#!/usr/bin/env node
/**
 * Derive the in-tree model price catalogue from its reviewed source table.
 *
 *   node scripts/generate-model-prices.mjs           # write the module
 *   node scripts/generate-model-prices.mjs --check   # re-derive and diff, exit 1 on drift
 *
 * ## Why the source is a file and not a fetch
 *
 * The property worth having is that a cost number is reproducible from a commit
 * and that an offline run still prices correctly. A build-time fetch gives you
 * neither: two builds of the same commit can disagree, and a machine with no
 * network produces a catalogue with no prices in it.
 *
 * It is also the wrong shape for the thing being carried. A rate is a
 * commercial fact, and an auto-refreshing generator would change every
 * consumer's reported cost — and every consumer's `costLimitUsd` behaviour —
 * on a commit that never mentioned pricing, with no diff for anyone to read.
 * Refreshing is a human step, and it leaves a reviewable diff in the source.
 *
 * ## Why corrections are an input, never an edit to the output
 *
 * The obvious alternative is to merge the newly generated table against the
 * previous generated file so a hand correction survives regeneration. That is
 * rejected here on its own terms: merge-against-previous makes the output a
 * function of its own history, so it stops being reproducible from a commit —
 * which is the property the whole arrangement exists to get. It also cannot
 * tell a human correction apart from a row upstream dropped last month.
 *
 * So there is nothing to merge. A correction is an edit to the SOURCE, the
 * generated module is `f(source)` and nothing else, and `--check` proves that
 * equality with no network and no ambiguity. Hand-editing the generated file
 * fails the gate, and the failure names the file to edit instead.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SDK_DIR = join(HERE, '..', 'packages', 'sdk')
const PRICING_DIR = join(SDK_DIR, 'src', 'pricing')
const SOURCE_PATH = join(PRICING_DIR, 'rates.source.json')
const OUTPUT_PATH = join(PRICING_DIR, 'catalogue.generated.ts')

/**
 * Put the rendered module through the same formatter the lint gate runs.
 *
 * Without this the two gates fight: this script emits one shape, `pnpm lint`
 * rewrites it to another, and then `--check` reports drift on a file nobody
 * touched. Whichever ran last would be red, and the obvious "fix" — hand-edit
 * the generated file — is the exact thing the drift check exists to forbid.
 *
 * Formatting the RENDERED STRING rather than the file on disk is what makes
 * `--check` sound: both sides of the comparison go through the formatter, so
 * the check asks "is this file what the generator produces?" and not "has
 * anyone run a formatter since?".
 *
 * A failure here throws rather than falling back to the unformatted text. A
 * generator that quietly emitted a shape the lint gate rejects would hand the
 * next person a red build with no cause attached, and "I could not format it"
 * is not the same answer as "it needed no formatting".
 */
function biomeEntryPoint() {
	// The package's own `bin` script, run through this same node. Deliberately
	// not `npx`: on Windows that is a `.cmd`, which `execFileSync` cannot spawn
	// without a shell, and reaching for a shell to run a formatter invites
	// quoting bugs on one platform that nobody sees on the other two.
	const candidates = [
		join(HERE, '..', 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
		join(SDK_DIR, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'),
	]
	for (const candidate of candidates) {
		try {
			readFileSync(candidate)
			return candidate
		} catch {
			// try the next
		}
	}
	throw new Error(
		`Could not find the biome CLI. Looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}\n` +
			'Run `pnpm install` first — the generated module is formatted with the same\n' +
			'formatter the lint gate runs, so that the two cannot disagree about it.',
	)
}

function formatted(source) {
	return execFileSync(
		process.execPath,
		[biomeEntryPoint(), 'format', '--stdin-file-path=src/pricing/catalogue.generated.ts'],
		{ cwd: SDK_DIR, input: source, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
	)
}

/** Refuse a source that would generate a table nobody can trust. */
function validate(source) {
	const problems = []
	if (!Array.isArray(source.vendors) || source.vendors.length === 0) {
		problems.push('`vendors` must be a non-empty array.')
		return problems
	}
	const seenVendors = new Set()
	for (const vendor of source.vendors) {
		const where = `vendor "${vendor.providerId}"`
		if (typeof vendor.providerId !== 'string' || vendor.providerId.length === 0) {
			problems.push('a vendor has no `providerId`.')
			continue
		}
		if (seenVendors.has(vendor.providerId)) {
			problems.push(`${where} appears twice; a lookup would silently take one of them.`)
		}
		seenVendors.add(vendor.providerId)
		if (typeof vendor.unmetered !== 'boolean') {
			problems.push(`${where} must declare \`unmetered\` explicitly — absent is not a default.`)
		}
		if (!Array.isArray(vendor.models)) {
			problems.push(`${where} has no \`models\` array.`)
			continue
		}
		if (vendor.unmetered === true && vendor.models.length > 0) {
			problems.push(
				`${where} is unmetered but lists models. An unmetered driver bills nothing whatever the model, so a per-model rate there is a claim two answers wide.`,
			)
		}
		if (vendor.unmetered === false) {
			// Two facts about the DRIVER, without which the two cache rates
			// below cannot be applied to anything. Required rather than
			// defaulted: guessing either one is off by the whole cache volume,
			// in a direction that depends on which driver served the turn.
			for (const field of ['promptIncludesCacheReads', 'reportsCacheWrites']) {
				if (typeof vendor[field] !== 'boolean') {
					problems.push(`${where} must declare \`${field}\` — it is measured from the driver, not inferred.`)
				}
			}
		}
		const seenModels = new Set()
		for (const model of vendor.models) {
			if (typeof model.id !== 'string' || model.id.length === 0) {
				problems.push(`${where} has a model with no id.`)
				continue
			}
			if (model.id !== model.id.toLowerCase()) {
				problems.push(
					`${where} model "${model.id}" is not lowercase; lookup normalises to lowercase and would never reach it.`,
				)
			}
			if (seenModels.has(model.id)) {
				problems.push(`${where} lists model "${model.id}" twice.`)
			}
			seenModels.add(model.id)
			const required = ['inputPer1M', 'outputPer1M', 'cacheReadPer1M']
			if (vendor.reportsCacheWrites === true) required.push('cacheWritePer1M')
			for (const field of required) {
				const value = model[field]
				if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
					problems.push(`${where} model "${model.id}" has a non-finite or negative \`${field}\`.`)
				}
			}
			if (vendor.reportsCacheWrites === false && model.cacheWritePer1M !== undefined) {
				problems.push(
					`${where} model "${model.id}" carries a write rate while the vendor declares it never reports cache writes. One of the two is wrong, and a rate nothing multiplies is the kind of declaration this table exists to keep out.`,
				)
			}
		}
	}
	return problems
}

function render(source) {
	const vendors = [...source.vendors].sort((a, b) => a.providerId.localeCompare(b.providerId))

	const body = vendors
		.map((vendor) => {
			const rows = [...vendor.models]
				.sort((a, b) => a.id.localeCompare(b.id))
				.map((model) => {
					const cache = [
						`promptIncludesCacheReads: ${vendor.promptIncludesCacheReads}`,
						`readCostPer1M: ${model.cacheReadPer1M}`,
						...(model.cacheWritePer1M === undefined
							? []
							: [`writeCostPer1M: ${model.cacheWritePer1M}`]),
					].join(', ')
					return (
						`\t\t\t['${model.id}', { inputCostPer1M: ${model.inputPer1M}, ` +
						`outputCostPer1M: ${model.outputPer1M}, cache: { ${cache} } }],`
					)
				})
			const models = rows.length === 0 ? '\t\t\t// none — see `unmetered`.\n' : `${rows.join('\n')}\n`
			return [
				`\t{`,
				`\t\tproviderId: '${vendor.providerId}',`,
				`\t\tunmetered: ${vendor.unmetered},`,
				`\t\tmodels: new Map([`,
				models.replace(/\n$/, ''),
				`\t\t]),`,
				`\t},`,
			].join('\n')
		})
		.join('\n')

	const counted = vendors.reduce((total, vendor) => total + vendor.models.length, 0)

	return `// GENERATED FILE — DO NOT EDIT.
//
// Produced by \`node scripts/generate-model-prices.mjs\` from
// \`packages/sdk/src/pricing/rates.source.json\`, which is the file to edit.
// CI re-runs the generator and fails on any difference, so a hand edit here is
// reverted by the next run at best and reported as drift at worst.
//
// ${vendors.length} vendors, ${counted} priced models.

import type { ModelPricing } from '../utils/cost.js'

export interface VendorRates {
	/** Matched against \`LLMProvider.id\`. */
	readonly providerId: string
	/**
	 * This driver bills nothing for a token, whatever the model — local
	 * inference. Its runs are priced at zero, which is KNOWN-free and so
	 * distinct from a model nobody has a rate for.
	 */
	readonly unmetered: boolean
	/** Keyed by normalised model id. Empty when \`unmetered\`. */
	readonly models: ReadonlyMap<string, ModelPricing>
}

export const VENDOR_RATES: readonly VendorRates[] = [
${body}
]
`
}

/**
 * The validator's own cases, asserted on every run before the source is read.
 *
 * `scripts/` has no test runner, so without this the refusals above are
 * defended by nothing — and they are refusals that only ever run against a
 * source which passes, so every branch of them is dead in practice. Measured
 * rather than argued: deleting the duplicate-id check, the unmetered-with-rows
 * check, and the required-cache-rate check each left the whole gate green.
 *
 * A disagreement exits 2 rather than 1, so a broken validator is never read as
 * a clean table. Same shape and same reasoning as the self-check in
 * `scripts/audit-external-names.mjs`.
 */
const VALIDATOR_CASES = [
	['a good table passes', { vendors: [vendorFixture()] }, 0],
	['no vendors at all', { vendors: [] }, 1],
	[
		'the same vendor twice',
		{ vendors: [vendorFixture(), vendorFixture()] },
		1,
	],
	[
		'a vendor that does not say whether it is metered',
		{ vendors: [{ ...vendorFixture(), unmetered: undefined }] },
		1,
	],
	[
		'an unmetered vendor that also lists rates',
		{ vendors: [{ ...vendorFixture(), unmetered: true }] },
		// Two complaints: the rows, and the cache-semantics fields it no
		// longer needs to declare but still carries a model for.
		1,
	],
	[
		'a metered vendor that does not declare its cache-token semantics',
		{ vendors: [{ ...vendorFixture(), promptIncludesCacheReads: undefined }] },
		1,
	],
	[
		'the same model id twice',
		{ vendors: [vendorFixture({ models: [modelFixture(), modelFixture()] })] },
		1,
	],
	[
		'a model id that lookup could never reach',
		{ vendors: [vendorFixture({ models: [modelFixture({ id: 'GPT-Mixed-Case' })] })] },
		1,
	],
	[
		'a model with no cache read rate',
		{ vendors: [vendorFixture({ models: [modelFixture({ cacheReadPer1M: undefined })] })] },
		1,
	],
	[
		'a model with a negative rate',
		{ vendors: [vendorFixture({ models: [modelFixture({ inputPer1M: -1 })] })] },
		1,
	],
	[
		'a write rate on a vendor that never reports writes',
		{
			vendors: [
				vendorFixture({ reportsCacheWrites: false, models: [modelFixture({ cacheWritePer1M: 1 })] }),
			],
		},
		1,
	],
	[
		'no write rate on a vendor that does report writes',
		{
			vendors: [
				vendorFixture({
					reportsCacheWrites: true,
					models: [modelFixture({ cacheWritePer1M: undefined })],
				}),
			],
		},
		1,
	],
]

function modelFixture(over = {}) {
	return { id: 'm-1', inputPer1M: 1, outputPer1M: 2, cacheReadPer1M: 0.1, ...over }
}

function vendorFixture(over = {}) {
	return {
		providerId: 'v',
		unmetered: false,
		promptIncludesCacheReads: true,
		reportsCacheWrites: false,
		models: [modelFixture()],
		...over,
	}
}

function selfCheck() {
	const broken = []
	for (const [label, table, minimumProblems] of VALIDATOR_CASES) {
		const found = validate(table).length
		if (minimumProblems === 0 ? found !== 0 : found < minimumProblems) {
			broken.push(
				`${label}: expected ${minimumProblems === 0 ? 'no complaint' : 'a complaint'}, got ${found}`,
			)
		}
	}
	if (broken.length === 0) return
	console.error('the rate-table validator disagrees with its own cases:\n')
	for (const line of broken) console.error(`  ${line}`)
	console.error('\nThis is the validator being wrong, not the table being bad.')
	process.exit(2)
}

selfCheck()

const source = JSON.parse(readFileSync(SOURCE_PATH, 'utf8'))

const problems = validate(source)
if (problems.length > 0) {
	console.error(`rates.source.json is not usable — ${problems.length} problem(s):\n`)
	for (const problem of problems) console.error(`  ${problem}`)
	process.exit(2)
}

const rendered = formatted(render(source))

if (!process.argv.includes('--check')) {
	writeFileSync(OUTPUT_PATH, rendered)
	const models = source.vendors.reduce((total, vendor) => total + vendor.models.length, 0)
	console.log(`catalogue.generated.ts written: ${source.vendors.length} vendors, ${models} models`)
	process.exit(0)
}

let onDisk
try {
	onDisk = readFileSync(OUTPUT_PATH, 'utf8')
} catch {
	console.error(
		'catalogue.generated.ts is missing. Run `node scripts/generate-model-prices.mjs` and commit it.',
	)
	process.exit(1)
}

if (onDisk === rendered) {
	console.log('model price catalogue matches its source')
	process.exit(0)
}

const actual = onDisk.split('\n')
const expected = rendered.split('\n')
const firstDifference = expected.findIndex((line, index) => line !== actual[index])

console.error('✗ MODEL PRICE CATALOGUE DRIFT\n')
console.error('  catalogue.generated.ts is not what rates.source.json produces.')
console.error(`  First difference at line ${firstDifference + 1}:`)
console.error(`    on disk:  ${JSON.stringify(actual[firstDifference] ?? '<end of file>')}`)
console.error(`    expected: ${JSON.stringify(expected[firstDifference] ?? '<end of file>')}`)
console.error(
	'\n  A generated file that has drifted from its generator is a lie with a\n' +
		'  timestamp: it reads as reviewed data and is whatever somebody last typed.\n' +
		'\n  If the rate is wrong, fix packages/sdk/src/pricing/rates.source.json —\n' +
		'  that is where a correction belongs and it survives every regeneration.\n' +
		'  Then run:\n' +
		'    node scripts/generate-model-prices.mjs\n' +
		'  and commit both files together.',
)
process.exit(1)
