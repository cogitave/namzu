/**
 * A Zen catalogue assembled at run time from the same sources, by the same
 * rules, as the bundled snapshot in `models.ts`.
 *
 * Nothing here reaches the network. `buildZenCatalogue` turns source TEXTS
 * into a catalogue; `fetch.ts` is the one place those texts are fetched, and
 * only when a caller asks. `parseZenCatalogue` re-admits a catalogue a host
 * stored earlier, with the same strictness a fresh derivation has: a document
 * that is not exactly a catalogue is refused whole, never read in part.
 */

import type { ModelInputModality, ReasoningEffort } from '@namzu/sdk'

import {
	ZEN_OMITTED_MODELS,
	type ZenModel,
	type ZenProtocol,
	type ZenService,
	findZenModel,
	getZenModels,
} from '../models.js'
import {
	type DerivedZenModel,
	type ModelsDevProvider,
	ZEN_SERVICES,
	ZenCatalogueSourceError,
	type ZenOmissions,
	checkRosterFloor,
	derive,
	parsePage,
	parseServed,
} from './derive.js'

/** The stored shape's version. A document carrying any other is refused. */
export const ZEN_CATALOGUE_VERSION = 1

/**
 * A complete Zen and Go roster.
 *
 * `unrouted` lists, per service, the ids the service's own `/models` answer
 * serves that this catalogue neither carries nor omits by review: no source
 * states a wire for them (or the rest of what carrying needs), so a driver
 * lists them as having no known wire format and calls one only when its host
 * names the protocol explicitly.
 */
export interface ZenCatalogue {
	readonly version: typeof ZEN_CATALOGUE_VERSION
	/** When the sources were read, as an ISO 8601 timestamp. */
	readonly fetchedAt: string
	readonly zen: readonly ZenModel[]
	readonly go: readonly ZenModel[]
	readonly unrouted: Readonly<Record<ZenService, readonly string[]>>
}

/** What a derivation found and did not carry. Informational: none of it fails a build. */
export interface ZenCatalogueReport {
	/** `service/id`: served by the service, documented on no page, omitted by nothing. */
	readonly servedUndocumented: readonly string[]
	/** `[service/id, why]`: documented, not carryable, omitted by nothing. */
	readonly undecided: readonly (readonly [string, string])[]
	/** `service/id`: omissions upstream neither documents nor serves any more. */
	readonly stale: readonly string[]
	/** `service: name`: price rows no route row names. */
	readonly orphanPrices: readonly string[]
}

/** The five upstream documents, as the texts they were served as. */
export interface ZenCatalogueSources {
	readonly docs: Readonly<Record<ZenService, string>>
	/** `https://models.dev/api.json`. */
	readonly modelsDev: string
	/** Each service's own `/models` answer. */
	readonly served: Readonly<Record<ZenService, string>>
}

export interface BuildZenCatalogueOptions {
	/**
	 * Reviewed omissions, as `service/id` keys or the review file's record.
	 * Defaults to the decisions the bundled snapshot was generated under.
	 */
	readonly omissions?: ZenOmissions
	/**
	 * The roster a result is measured against for collapse: fewer than 80% of
	 * its models on either service refuses the result. Defaults to the bundled
	 * snapshot.
	 */
	readonly baseline?: Readonly<Record<ZenService, readonly unknown[]>>
	/** Stamped as `fetchedAt`. Defaults to now. */
	readonly fetchedAt?: Date
}

export interface ZenCatalogueResult {
	readonly catalogue: ZenCatalogue
	readonly report: ZenCatalogueReport
}

/**
 * Derive a catalogue from upstream texts, or throw `ZenCatalogueSourceError`.
 *
 * All or nothing: a page that moved, a models.dev that changed shape, a served
 * answer with no ids or a roster that collapsed past the floor refuses the
 * whole result, so a caller holding an older catalogue keeps it rather than
 * receiving part of a new one.
 */
export function buildZenCatalogue(
	sources: ZenCatalogueSources,
	options: BuildZenCatalogueOptions = {},
): ZenCatalogueResult {
	const omissions = options.omissions ?? new Set(ZEN_OMITTED_MODELS)
	const omitted = omissions instanceof Set ? omissions : new Set(Object.keys(omissions))
	let modelsDev: unknown
	try {
		modelsDev = JSON.parse(sources.modelsDev)
	} catch (error) {
		throw new ZenCatalogueSourceError(
			`models.dev is not JSON: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	const carried: Record<ZenService, ZenModel[]> = { zen: [], go: [] }
	const unrouted: Record<ZenService, string[]> = { zen: [], go: [] }
	const servedUndocumented: string[] = []
	const undecided: [string, string][] = []
	const stale: string[] = []
	const orphanPrices: string[] = []
	for (const { service, page, provider } of ZEN_SERVICES) {
		const parsed = parsePage(sources.docs[service], { page, service })
		const served = parseServed(service, sources.served[service])
		const entry =
			modelsDev !== null && typeof modelsDev === 'object'
				? (modelsDev as Record<string, unknown>)[provider]
				: undefined
		const models =
			entry !== null && typeof entry === 'object'
				? (entry as { models?: unknown }).models
				: undefined
		if (models === null || typeof models !== 'object' || Array.isArray(models)) {
			throw new ZenCatalogueSourceError(`models.dev has no \`${provider}\` provider entry.`)
		}
		const derived = derive(
			service,
			parsed,
			provider,
			{ models } as ModelsDevProvider,
			omitted,
			served,
		)
		carried[service] = derived.models.map(toZenModel)
		const ids = new Set(carried[service].map((model) => model.id))
		unrouted[service] = [...served]
			.filter((id) => !ids.has(id) && !omitted.has(`${service}/${id}`))
			.sort()
		servedUndocumented.push(...derived.servedUncurried.map((id) => `${service}/${id}`))
		undecided.push(...derived.undecided)
		stale.push(...derived.stale.map((id) => `${service}/${id}`))
		orphanPrices.push(...derived.orphanPrices.map((name) => `${service}: ${name}`))
	}
	checkRosterFloor(
		carried,
		options.baseline ?? { zen: getZenModels('zen'), go: getZenModels('go') },
	)
	const catalogue = freezeCatalogue({
		version: ZEN_CATALOGUE_VERSION,
		fetchedAt: (options.fetchedAt ?? new Date()).toISOString(),
		zen: carried.zen,
		go: carried.go,
		unrouted,
	})
	return {
		catalogue,
		report: Object.freeze({
			servedUndocumented: Object.freeze(servedUndocumented),
			undecided: Object.freeze(undecided.map((pair) => Object.freeze(pair))),
			stale: Object.freeze(stale),
			orphanPrices: Object.freeze(orphanPrices),
		}),
	}
}

/** The shape the bundled snapshot uses: streaming stated, anonymity only when true. */
function toZenModel(model: DerivedZenModel): ZenModel {
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
		supportsStreaming: true,
		effortLevels: [...model.effortLevels],
		...(model.supportsAnonymousAccess ? { supportsAnonymousAccess: true } : {}),
	}
}

function freezeCatalogue(catalogue: {
	version: typeof ZEN_CATALOGUE_VERSION
	fetchedAt: string
	zen: ZenModel[]
	go: ZenModel[]
	unrouted: Record<ZenService, string[]>
}): ZenCatalogue {
	for (const service of ['zen', 'go'] as const) {
		for (const model of catalogue[service]) {
			if (model.inputModalities) Object.freeze(model.inputModalities)
			if (model.effortLevels) Object.freeze(model.effortLevels)
			Object.freeze(model)
		}
		Object.freeze(catalogue[service])
		Object.freeze(catalogue.unrouted[service])
	}
	Object.freeze(catalogue.unrouted)
	return Object.freeze(catalogue)
}

const MODEL_ID = /^[a-z0-9][a-z0-9.-]*$/
const PROTOCOLS: ReadonlySet<string> = new Set<ZenProtocol>([
	'chat',
	'responses',
	'messages',
	'google',
])
const INPUT_MODALITIES: ReadonlySet<string> = new Set<ModelInputModality>([
	'text',
	'image',
	'document',
])
const EFFORTS: ReadonlySet<string> = new Set<ReasoningEffort>([
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
])
const MODEL_KEYS: ReadonlySet<string> = new Set([
	'id',
	'name',
	'protocol',
	'contextWindow',
	'maxOutputTokens',
	'inputModalities',
	'inputPrice',
	'outputPrice',
	'supportsToolUse',
	'supportsStreaming',
	'effortLevels',
	'supportsAnonymousAccess',
])

/** A stored catalogue that is not exactly a catalogue. */
export class ZenCatalogueFormatError extends Error {
	override readonly name = 'ZenCatalogueFormatError'
}

function invalid(where: string, why: string): never {
	throw new ZenCatalogueFormatError(`${where} ${why}.`)
}

function record(value: unknown, where: string): Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		invalid(where, 'is not an object')
	}
	return value as Record<string, unknown>
}

function onlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>, where: string): void {
	for (const key of Object.keys(value)) {
		if (!keys.has(key)) invalid(`${where}.${key}`, 'is not a catalogue field')
	}
}

function positiveInteger(value: unknown, where: string): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
		invalid(where, 'is not a positive integer')
	}
	return value
}

function price(value: unknown, where: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		invalid(where, 'is not a non-negative price')
	}
	return value
}

function members<T extends string>(
	value: unknown,
	allowed: ReadonlySet<string>,
	where: string,
	nonEmpty: boolean,
): T[] {
	if (!Array.isArray(value)) invalid(where, 'is not a list')
	if (nonEmpty && value.length === 0) invalid(where, 'is empty')
	for (const item of value) {
		if (typeof item !== 'string' || !allowed.has(item)) {
			invalid(where, `names ${JSON.stringify(item)}, which is not one it may name`)
		}
	}
	if (new Set(value).size !== value.length) invalid(where, 'repeats an entry')
	return [...(value as T[])]
}

function parseModel(value: unknown, service: ZenService, where: string): ZenModel {
	const raw = record(value, where)
	onlyKeys(raw, MODEL_KEYS, where)
	const id = raw.id
	if (typeof id !== 'string' || !MODEL_ID.test(id)) invalid(`${where}.id`, 'is not a model id')
	const name = raw.name
	if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) {
		invalid(`${where}.name`, 'is not a model name')
	}
	const protocol = raw.protocol
	if (typeof protocol !== 'string' || !PROTOCOLS.has(protocol)) {
		invalid(`${where}.protocol`, 'is not a Zen protocol')
	}
	if (typeof raw.supportsToolUse !== 'boolean') {
		invalid(`${where}.supportsToolUse`, 'is not true or false')
	}
	if (raw.supportsStreaming !== true) invalid(`${where}.supportsStreaming`, 'is not true')
	const anonymous = raw.supportsAnonymousAccess
	if (anonymous !== undefined && (anonymous !== true || service !== 'zen')) {
		invalid(`${where}.supportsAnonymousAccess`, 'is only ever `true`, and only on zen')
	}
	return {
		id,
		name,
		protocol: protocol as ZenProtocol,
		contextWindow: positiveInteger(raw.contextWindow, `${where}.contextWindow`),
		maxOutputTokens: positiveInteger(raw.maxOutputTokens, `${where}.maxOutputTokens`),
		inputModalities: members<ModelInputModality>(
			raw.inputModalities,
			INPUT_MODALITIES,
			`${where}.inputModalities`,
			true,
		),
		inputPrice: price(raw.inputPrice, `${where}.inputPrice`),
		outputPrice: price(raw.outputPrice, `${where}.outputPrice`),
		supportsToolUse: raw.supportsToolUse,
		supportsStreaming: true,
		effortLevels: members<ReasoningEffort>(
			raw.effortLevels,
			EFFORTS,
			`${where}.effortLevels`,
			false,
		),
		...(anonymous === true ? { supportsAnonymousAccess: true } : {}),
	}
}

/**
 * Re-admit a catalogue a host stored — the output of `JSON.parse` on what
 * `JSON.stringify(catalogue)` wrote — or throw `ZenCatalogueFormatError`.
 *
 * Every field is checked as strictly as a derivation checks its sources, and a
 * document with one bad field is refused whole: a cache someone edited, a
 * truncated write or a file from another version never becomes a partial
 * roster.
 */
export function parseZenCatalogue(value: unknown): ZenCatalogue {
	const raw = record(value, 'catalogue')
	onlyKeys(raw, new Set(['version', 'fetchedAt', 'zen', 'go', 'unrouted']), 'catalogue')
	if (raw.version !== ZEN_CATALOGUE_VERSION) {
		invalid('catalogue.version', `is not ${ZEN_CATALOGUE_VERSION}`)
	}
	const fetchedAt = raw.fetchedAt
	if (
		typeof fetchedAt !== 'string' ||
		Number.isNaN(Date.parse(fetchedAt)) ||
		new Date(fetchedAt).toISOString() !== fetchedAt
	) {
		invalid('catalogue.fetchedAt', 'is not an ISO 8601 timestamp')
	}
	const unroutedRaw = record(raw.unrouted, 'catalogue.unrouted')
	onlyKeys(unroutedRaw, new Set(['zen', 'go']), 'catalogue.unrouted')
	const carried: Record<ZenService, ZenModel[]> = { zen: [], go: [] }
	const unrouted: Record<ZenService, string[]> = { zen: [], go: [] }
	for (const service of ['zen', 'go'] as const) {
		const list = raw[service]
		if (!Array.isArray(list) || list.length === 0) {
			invalid(`catalogue.${service}`, 'is not a non-empty list of models')
		}
		carried[service] = list.map((entry, index) =>
			parseModel(entry, service, `catalogue.${service}[${index}]`),
		)
		const ids = new Set(carried[service].map((model) => model.id))
		if (ids.size !== carried[service].length) invalid(`catalogue.${service}`, 'repeats a model id')
		const names = unroutedRaw[service]
		if (!Array.isArray(names)) invalid(`catalogue.unrouted.${service}`, 'is not a list')
		for (const id of names) {
			if (typeof id !== 'string' || !MODEL_ID.test(id)) {
				invalid(
					`catalogue.unrouted.${service}`,
					`names ${JSON.stringify(id)}, which is not a model id`,
				)
			}
			if (ids.has(id)) invalid(`catalogue.unrouted.${service}`, `names the carried model "${id}"`)
		}
		if (new Set(names).size !== names.length) {
			invalid(`catalogue.unrouted.${service}`, 'repeats an id')
		}
		unrouted[service] = [...(names as string[])]
	}
	return freezeCatalogue({
		version: ZEN_CATALOGUE_VERSION,
		fetchedAt,
		zen: carried.zen,
		go: carried.go,
		unrouted,
	})
}

/**
 * Exact lookup with the runtime catalogue first and the bundled snapshot
 * second. `catalogue` undefined is the bundled snapshot alone.
 */
export function findZenCatalogueModel(
	catalogue: ZenCatalogue | undefined,
	service: ZenService,
	id: string,
): ZenModel | undefined {
	return catalogue?.[service].find((model) => model.id === id) ?? findZenModel(service, id)
}

/** Whether a runtime catalogue lists `id` as served with no known wire format. */
export function isUnroutedZenModel(
	catalogue: ZenCatalogue | undefined,
	service: ZenService,
	id: string,
): boolean {
	return catalogue?.unrouted[service].includes(id) === true
}
