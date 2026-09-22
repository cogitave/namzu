import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { type LogRecord, createLogger } from '@namzu/sdk'
import { ZenProvider } from '@namzu/zen'
import { type ZenCatalogue, type ZenCatalogueResult, parseZenCatalogue } from '@namzu/zen/catalogue'
import { findZenModel } from '@namzu/zen/models'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { __resetCliLoggerForTests, cliLogger, installCliLogging } from '../../logging.js'
import { requiresCredentialForModel } from './access.js'
import { PROVIDER_REGISTRY } from './registry.js'
import {
	ZEN_CATALOGUE_CACHE_PATH,
	__resetZenCatalogueForTests,
	activeZenCatalogue,
	activeZenCatalogueSource,
	findActiveZenModel,
	isOfferableModel,
	startZenCatalogueRefresh,
	writeLastGood,
} from './zen-catalogue.js'

const homes: string[] = []
function home(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-zen-catalogue-'))
	homes.push(dir)
	return dir
}

afterEach(() => {
	__resetZenCatalogueForTests()
	for (const dir of homes.splice(0)) removeTempDir(dir)
})

function capturing() {
	const records: LogRecord[] = []
	const log = createLogger({
		sink: { emit: (record) => records.push(record) },
		level: { current: 'debug' },
		resource: { 'service.name': 'namzu' },
		scope: 'test',
	})
	return { log, records, warnings: () => records.filter((r) => r.severityText === 'warn') }
}

const model = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	protocol: 'chat',
	contextWindow: 100_000,
	maxOutputTokens: 8_192,
	inputModalities: ['text'],
	inputPrice: 1,
	outputPrice: 2,
	supportsToolUse: true,
	supportsStreaming: true,
	effortLevels: [],
	...extra,
})

/** A small, valid catalogue carrying a model the bundled snapshot does not know. */
function catalogue(tag = 'fresh'): ZenCatalogue {
	return parseZenCatalogue({
		version: 1,
		fetchedAt: '2026-09-22T00:00:00.000Z',
		zen: [
			model(`${tag}-model`, { contextWindow: 123_456 }),
			model(`${tag}-free`, { inputPrice: 0, outputPrice: 0, supportsAnonymousAccess: true }),
		],
		go: [model(`${tag}-go`)],
		unrouted: { zen: ['served-only'], go: [] },
	})
}

const result = (value: ZenCatalogue): ZenCatalogueResult => ({
	catalogue: value,
	report: { servedUndocumented: [], undecided: [], stale: [], orphanPrices: [] },
})

/** A derivation that never settles until its signal aborts — an unreachable network. */
function hanging() {
	const seen: AbortSignal[] = []
	const fetchCatalogue = (options: { signal: AbortSignal }) => {
		seen.push(options.signal)
		return new Promise<ZenCatalogueResult>((_resolve, reject) => {
			options.signal.addEventListener('abort', () => reject(options.signal.reason))
		})
	}
	return { fetchCatalogue, seen }
}

async function isPending(promise: Promise<unknown>): Promise<boolean> {
	const marker = Symbol('pending')
	return (
		(await Promise.race([promise, new Promise((r) => setTimeout(() => r(marker), 20))])) === marker
	)
}

describe('startZenCatalogueRefresh', () => {
	/**
	 * The startup contract. The handle comes back synchronously, before the
	 * refresh has read the disk or asked the network for anything, and the
	 * refresh is still outstanding afterwards — so a caller that goes straight
	 * on with its launch is not waiting on it.
	 */
	it('returns before it reads or fetches anything, and leaves the refresh outstanding', async () => {
		const { log } = capturing()
		const { fetchCatalogue, seen } = hanging()
		const refresh = startZenCatalogueRefresh({ home: home(), log, fetchCatalogue })
		expect(seen).toHaveLength(0)
		expect(await isPending(refresh.done)).toBe(true)
		expect(seen).toHaveLength(1)
		refresh.cancel()
		await expect(refresh.done).resolves.toEqual({ kind: 'cancelled' })
		expect(seen[0]?.aborted).toBe(true)
	})

	it('makes a refresh that lands the active catalogue and writes it as the last-good copy', async () => {
		const dir = home()
		const { log, warnings } = capturing()
		const fresh = catalogue()
		const refresh = startZenCatalogueRefresh({
			home: dir,
			log,
			fetchCatalogue: async () => result(fresh),
		})
		await expect(refresh.done).resolves.toEqual({ kind: 'live', catalogue: fresh })
		expect(activeZenCatalogue()).toBe(fresh)
		expect(activeZenCatalogueSource()).toBe('live')
		expect(warnings()).toHaveLength(0)
		const stored = parseZenCatalogue(
			JSON.parse(readFileSync(join(dir, ZEN_CATALOGUE_CACHE_PATH), 'utf8')),
		)
		expect(stored).toEqual(fresh)
	})

	it('keeps the last-good copy when the next refresh fails, and says so in one line', async () => {
		const dir = home()
		await writeLastGood(join(dir, ZEN_CATALOGUE_CACHE_PATH), catalogue('cached'))
		const { log, warnings } = capturing()
		const refresh = startZenCatalogueRefresh({
			home: dir,
			log,
			fetchCatalogue: async () => {
				throw new Error('models.dev answered 503.')
			},
		})
		await expect(refresh.done).resolves.toEqual({
			kind: 'failed',
			using: 'cache',
			reason: 'models.dev answered 503.',
		})
		expect(activeZenCatalogueSource()).toBe('cache')
		expect(findActiveZenModel('zen', 'cached-model')?.contextWindow).toBe(123_456)
		expect(warnings()).toHaveLength(1)
		expect(warnings()[0]?.attributes).toMatchObject({ 'namzu.zen_catalogue.using': 'cache' })
	})

	it('falls back to the bundled snapshot with no last-good copy', async () => {
		const { log, warnings } = capturing()
		const refresh = startZenCatalogueRefresh({
			home: home(),
			log,
			fetchCatalogue: async () => {
				throw new Error('offline')
			},
		})
		await expect(refresh.done).resolves.toMatchObject({ kind: 'failed', using: 'bundled' })
		expect(activeZenCatalogue()).toBeUndefined()
		expect(findActiveZenModel('zen', 'glm-5.3-flash')).toBe(findZenModel('zen', 'glm-5.3-flash'))
		expect(warnings()).toHaveLength(1)
	})

	it.each([
		['a torn write', (text: string) => text.slice(0, Math.floor(text.length / 2))],
		[
			'a hand edit with a field it does not know',
			(text: string) => text.replace('"version":1', '"version":1,"extra":1'),
		],
		[
			'a model with a protocol it cannot route',
			(text: string) => text.replace('"protocol":"chat"', '"protocol":"smtp"'),
		],
	])('never adopts %s as a half-parsed list', async (_why, damage) => {
		const dir = home()
		const path = join(dir, ZEN_CATALOGUE_CACHE_PATH)
		await writeLastGood(path, catalogue('cached'))
		writeFileSync(path, damage(readFileSync(path, 'utf8')))
		const { log, warnings } = capturing()
		const refresh = startZenCatalogueRefresh({
			home: dir,
			log,
			fetchCatalogue: async () => {
				throw new Error('offline')
			},
		})
		await expect(refresh.done).resolves.toMatchObject({ kind: 'failed', using: 'bundled' })
		expect(activeZenCatalogue()).toBeUndefined()
		expect(findActiveZenModel('zen', 'cached-model')).toBeUndefined()
		// One line for the refused copy, one for the refresh.
		expect(warnings()).toHaveLength(2)
	})

	it('gives up within its budget rather than holding the launch', async () => {
		const { log, warnings } = capturing()
		const { fetchCatalogue } = hanging()
		const started = Date.now()
		const refresh = startZenCatalogueRefresh({ home: home(), log, fetchCatalogue, budgetMs: 50 })
		await expect(refresh.done).resolves.toEqual({
			kind: 'failed',
			using: 'bundled',
			reason: 'the refresh did not finish within 50ms',
		})
		expect(Date.now() - started).toBeLessThan(2_000)
		expect(warnings()).toHaveLength(1)
	})

	it('logs nothing when the launch ends first', async () => {
		const { log, records } = capturing()
		const { fetchCatalogue } = hanging()
		const refresh = startZenCatalogueRefresh({ home: home(), log, fetchCatalogue })
		refresh.cancel()
		await expect(refresh.done).resolves.toEqual({ kind: 'cancelled' })
		expect(records).toHaveLength(0)
	})

	it('reaches providers and credential checks built before it landed', async () => {
		const provider = new ZenProvider({ apiKey: 'fixture', catalogue: activeZenCatalogue })
		const zenEntry = PROVIDER_REGISTRY.zen
		expect(await provider.resolveContextWindow('fresh-model')).toBeUndefined()
		expect(requiresCredentialForModel(zenEntry, 'fresh-free')).toBe(true)
		const { log } = capturing()
		const fresh = catalogue()
		await startZenCatalogueRefresh({ home: home(), log, fetchCatalogue: async () => result(fresh) })
			.done
		expect(await provider.resolveContextWindow('fresh-model')).toBe(123_456)
		expect(requiresCredentialForModel(zenEntry, 'fresh-free')).toBe(false)
	})

	/**
	 * The TUI installs its ring buffer, and `exec --json` its NDJSON sink, after
	 * the refresh has started; each rebuilds the process logger. A refresh that
	 * kept the logger it started with would write its failure through the sink
	 * that was current at launch: raw text under Ink, or a pretty line on a
	 * stderr a host parses as NDJSON.
	 */
	it('writes each line through the process logger current when the line is logged', async () => {
		const before: LogRecord[] = []
		const after: LogRecord[] = []
		let fail: (error: Error) => void = () => {}
		try {
			installCliLogging({ emit: (record) => before.push(record) }, 'debug')
			const refresh = startZenCatalogueRefresh({
				home: home(),
				log: cliLogger,
				fetchCatalogue: () =>
					new Promise<ZenCatalogueResult>((_resolve, reject) => {
						fail = reject
					}),
			})
			await isPending(refresh.done)
			installCliLogging({ emit: (record) => after.push(record) }, 'debug')
			fail(new Error('offline'))
			await expect(refresh.done).resolves.toMatchObject({ kind: 'failed', reason: 'offline' })
			expect(before).toHaveLength(0)
			expect(after.map((record) => record.body)).toEqual([
				'Zen model catalogue refresh failed; keeping the catalogue already in use',
			])
		} finally {
			__resetCliLoggerForTests()
		}
	})

	it('offers every model except a Zen id the active catalogue serves with no known wire', async () => {
		expect(isOfferableModel('zen', 'served-only')).toBe(true)
		const { log } = capturing()
		await startZenCatalogueRefresh({
			home: home(),
			log,
			fetchCatalogue: async () => result(catalogue()),
		}).done
		expect(isOfferableModel('zen', 'served-only')).toBe(false)
		expect(isOfferableModel('zen', 'fresh-model')).toBe(true)
		// Unrouted is per service, and means nothing to another provider.
		expect(isOfferableModel('zen-go', 'served-only')).toBe(true)
		expect(isOfferableModel('openrouter', 'served-only')).toBe(true)
	})

	it('writes the last-good copy atomically, leaving no temp file behind', async () => {
		const dir = home()
		const path = join(dir, ZEN_CATALOGUE_CACHE_PATH)
		mkdirSync(dirname(path), { recursive: true })
		await writeLastGood(path, catalogue('first'))
		await writeLastGood(path, catalogue('second'))
		const { readdirSync } = await import('node:fs')
		expect(readdirSync(dirname(path))).toEqual(['zen-catalogue.json'])
		expect(parseZenCatalogue(JSON.parse(readFileSync(path, 'utf8'))).zen[0]?.id).toBe(
			'second-model',
		)
	})
})
