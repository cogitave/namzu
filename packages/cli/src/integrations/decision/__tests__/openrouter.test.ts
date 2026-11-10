import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { createDecisionModel } from '@namzu/decision'
import { loadConfig } from '../../../config/load.js'
import { writeStoredApiKey } from '../../providers/credential-store.js'
import { connectionToBlock, readConnection } from '../connection.js'
import { buildDecisionProviderConfig } from '../model.js'
import {
	DEFAULT_OPENROUTER_DECISION_MODEL,
	FALLBACK_OPENROUTER_DECISION_MODELS,
	OPENROUTER_DECISION_MODELS_URL,
	OPENROUTER_DECISION_URL,
	decisionModelOptions,
	fetchDecisionModels,
	findOpenRouterKey,
	openRouterKeyNotice,
	parseDecisionModels,
} from '../openrouter.js'
import {
	type TimeoutHandle,
	connectedNotice,
	draftToConnection,
	explainConnectionFailure,
	saveConnection,
	testDecisionConnection,
} from '../setup.js'

const FAKE_KEY = 'sk-or-test-0000000000000000'
const LIST = {
	data: [
		{
			id: 'typesafe/jev-1.14',
			name: 'Typesafe: JEV 1.14',
			pricing: { prompt: '0.000000042', completion: '0' },
			context_length: 32768,
			architecture: { output_modalities: ['decisions'] },
		},
		{
			id: 'parallel/decisions-fast:free',
			name: 'Parallel: Decisions Fast',
			pricing: { prompt: '0' },
			context_length: 8000,
		},
		{
			id: DEFAULT_OPENROUTER_DECISION_MODEL,
			name: 'Microsoft: Decision 1',
			pricing: { prompt: '0.000000042' },
			context_length: 1_000_000,
		},
		{
			id: 'perplexity/pplx-decider-flash-v1.2',
			name: 'Perplexity: Decider Flash',
			pricing: { prompt: 1e-8 },
		},
		{ id: 'no-price/model' },
		{ name: 'no id' },
	],
}

function scratch() {
	const home = mkdtempSync(join(tmpdir(), 'namzu-or-home-'))
	mkdirSync(join(home, '.namzu'), { recursive: true })
	return { home, opts: { home, env: {} as NodeJS.ProcessEnv } }
}

describe('the decision model list', () => {
	it('reads price per million input tokens, context and free, and sorts free then cheapest then by name', () => {
		const models = parseDecisionModels(LIST)
		expect(models.map((m) => m.id)).toEqual([
			'parallel/decisions-fast:free',
			'perplexity/pplx-decider-flash-v1.2',
			DEFAULT_OPENROUTER_DECISION_MODEL,
			'typesafe/jev-1.14',
			'no-price/model',
		])
		expect(models[0]).toMatchObject({ free: true, pricePerMillion: 0, contextLength: 8000 })
		expect(models[1]?.pricePerMillion).toBeCloseTo(0.01)
		expect(models[2]?.pricePerMillion).toBeCloseTo(0.042)
		expect(models[4]).toMatchObject({ id: 'no-price/model', name: 'no-price/model', free: false })
		expect(models[4]).not.toHaveProperty('pricePerMillion')
	})

	it('shows name, price, free and context, and selects Microsoft Decision 1 by default', () => {
		const { values, options, defaultIndex } = decisionModelOptions(parseDecisionModels(LIST))
		expect(values[defaultIndex]).toBe(DEFAULT_OPENROUTER_DECISION_MODEL)
		expect(options[0]).toMatchObject({
			label: 'Parallel: Decisions Fast',
			description: 'free · 8k context',
		})
		expect(options[defaultIndex]).toMatchObject({
			label: 'Microsoft: Decision 1',
			description: '$0.042 per 1M input tokens · 1M context',
		})
	})

	it('selects the first row when the default is not listed', () => {
		const { defaultIndex } = decisionModelOptions(parseDecisionModels({ data: [{ id: 'a/b' }] }))
		expect(defaultIndex).toBe(0)
	})

	it('is fetched from the decisions listing with a deadline', async () => {
		const asked: string[] = []
		const timeouts: number[] = []
		const result = await fetchDecisionModels({
			fetch: (async (url: string) => {
				asked.push(url)
				return new Response(JSON.stringify(LIST))
			}) as unknown as typeof fetch,
			startTimeout: (ms): TimeoutHandle => {
				timeouts.push(ms)
				return { signal: new AbortController().signal, clear: () => {} }
			},
		})
		expect(asked).toEqual([OPENROUTER_DECISION_MODELS_URL])
		expect(asked[0]).toContain('output_modalities=decisions')
		expect(timeouts).toEqual([3000])
		expect(result.ok && result.models.length).toBe(5)
	})

	it('is not ok when the request fails, answers an error, or lists nothing', async () => {
		const failing = (async () => {
			throw new Error('offline')
		}) as typeof fetch
		expect(await fetchDecisionModels({ fetch: failing })).toEqual({ ok: false })
		expect(
			await fetchDecisionModels({
				fetch: (async () => new Response('{}', { status: 500 })) as typeof fetch,
			}),
		).toEqual({ ok: false })
		expect(
			await fetchDecisionModels({
				fetch: (async () => new Response('{"data":[]}')) as typeof fetch,
			}),
		).toEqual({ ok: false })
	})

	it('has typed fallbacks for when the list cannot be loaded', () => {
		expect(FALLBACK_OPENROUTER_DECISION_MODELS).toEqual([
			'microsoft/microsoft-decision-1',
			'typesafe/jev-1.14',
		])
	})
})

describe('the key', () => {
	it('is reused from OPENROUTER_API_KEY without being read into the config', () => {
		const { home } = scratch()
		const found = findOpenRouterKey({ OPENROUTER_API_KEY: FAKE_KEY }, home)
		expect(found).toEqual({ source: 'env', env: 'OPENROUTER_API_KEY' })
		expect(openRouterKeyNotice(found as never)).toBe(
			'Using your OpenRouter key from OPENROUTER_API_KEY.',
		)
		expect(JSON.stringify(found)).not.toContain(FAKE_KEY)
	})

	it('is reused from the provider key in the credential store', () => {
		const { home } = scratch()
		writeStoredApiKey('openrouter', FAKE_KEY, home)
		const found = findOpenRouterKey({}, home)
		expect(found).toEqual({ source: 'store', key: FAKE_KEY })
		expect(openRouterKeyNotice(found as never)).toBe('Using the OpenRouter key you already saved.')
	})

	it('is absent when neither has one, so the flow asks', () => {
		expect(findOpenRouterKey({}, scratch().home)).toBeUndefined()
	})
})

describe('saving an OpenRouter connection', () => {
	it('writes an http block for the OpenRouter address with the model, and no key in config.yaml', () => {
		const { opts, home } = scratch()
		const out = saveConnection(
			{ kind: 'openrouter', model: 'typesafe/jev-1.14', key: FAKE_KEY },
			opts,
		)
		const config = readFileSync(out.configFile, 'utf8')
		expect(config).toContain(OPENROUTER_DECISION_URL)
		expect(config).toContain('typesafe/jev-1.14')
		expect(config).not.toContain(FAKE_KEY)
		expect(readFileSync(join(home, '.namzu', 'decision-connection.json'), 'utf8')).not.toContain(
			FAKE_KEY,
		)
		const cfg = loadConfig({ ...opts, cwd: mkdtempSync(join(tmpdir(), 'cwd-')) })
		expect(cfg.decision).toMatchObject({
			provider: 'http',
			url: OPENROUTER_DECISION_URL,
			model: 'typesafe/jev-1.14',
		})
	})

	it('names the variable, not the key, when the key lives in the environment', () => {
		const { opts } = scratch()
		const out = saveConnection(
			{
				kind: 'openrouter',
				model: DEFAULT_OPENROUTER_DECISION_MODEL,
				keyEnv: 'OPENROUTER_API_KEY',
			},
			opts,
		)
		expect(readConnection(opts)).toEqual({
			provider: 'http',
			url: OPENROUTER_DECISION_URL,
			model: DEFAULT_OPENROUTER_DECISION_MODEL,
			apiKeyEnv: 'OPENROUTER_API_KEY',
		})
		expect(readFileSync(out.configFile, 'utf8')).toContain('apiKeyEnv: OPENROUTER_API_KEY')
	})

	it('needs a model', () => {
		expect(draftToConnection({ kind: 'openrouter' })).toBeUndefined()
	})

	it('resolves to a working HttpDecisionModel config with the saved key as a bearer', async () => {
		const { opts } = scratch()
		const out = saveConnection(
			{ kind: 'openrouter', model: 'typesafe/jev-1.14', key: FAKE_KEY },
			opts,
		)
		const seen: { url: string; auth: string | null; body: Record<string, unknown> }[] = []
		const cfg = buildDecisionProviderConfig(
			connectionToBlock(out.connection),
			{},
			{
				readStoredKey: () => FAKE_KEY,
				fetch: (async (url: string, init: RequestInit) => {
					seen.push({
						url,
						auth: new Headers(init.headers).get('authorization'),
						body: JSON.parse(String(init.body)),
					})
					return new Response(JSON.stringify({ answers: { q: { noul: 0.7 } } }))
				}) as unknown as typeof fetch,
			},
		)
		const answer = await createDecisionModel(cfg).yesno('s', 'q?')
		expect(answer.p).toBe(0.7)
		expect(seen[0]?.url).toBe(OPENROUTER_DECISION_URL)
		expect(seen[0]?.auth).toBe(`Bearer ${FAKE_KEY}`)
		expect(seen[0]?.body.model).toBe('typesafe/jev-1.14')
	})

	it('reads the key from the named variable at call time', async () => {
		const cfg = buildDecisionProviderConfig(
			{
				provider: 'http',
				url: OPENROUTER_DECISION_URL,
				model: 'm',
				apiKeyEnv: 'OPENROUTER_API_KEY',
			},
			{ OPENROUTER_API_KEY: FAKE_KEY },
		)
		expect(cfg).toMatchObject({ provider: 'http', url: OPENROUTER_DECISION_URL, apiKey: FAKE_KEY })
	})
})

describe('testing an OpenRouter model', () => {
	const conn = { provider: 'http', url: OPENROUTER_DECISION_URL, model: 'm' } as const

	it('shows latency and the cost of the test when usage.cost is present', async () => {
		const ticks = [0, 310]
		const result = await testDecisionConnection(
			conn,
			{},
			{
				fetch: (async () =>
					new Response(
						JSON.stringify({ answers: { q: { noul: 0.6 } }, usage: { cost: 0.0000021 } }),
					)) as typeof fetch,
				now: () => ticks.shift() as number,
				readStoredKey: () => null,
			},
		)
		expect(result).toEqual({ ok: true, ms: 310, costUsd: 0.0000021 })
		expect(connectedNotice(result)).toBe('Connected · 310 ms · test cost $0.0000021')
	})

	it('shows only latency when the answer carries no cost', async () => {
		const result = await testDecisionConnection(
			conn,
			{},
			{
				fetch: (async () =>
					new Response(JSON.stringify({ answers: { q: { noul: 0.6 } } }))) as typeof fetch,
				now: () => 5,
				readStoredKey: () => null,
			},
		)
		expect(connectedNotice(result)).toBe('Connected · 0 ms')
	})

	it('says plainly that a 400 about the question shape means the model does not work with Namzu', async () => {
		const message = 'question 0 has missing or null instructions or criteria'
		const result = await testDecisionConnection(
			conn,
			{},
			{
				fetch: (async () =>
					new Response(JSON.stringify({ error: { message } }), { status: 400 })) as typeof fetch,
				readStoredKey: () => null,
			},
		)
		expect(result).toMatchObject({ ok: false, unsupportedModel: true })
		expect(result.ok ? '' : result.reason).toContain("does not work with Namzu's questions")
		expect(result.ok ? '' : result.reason).toContain(message)
	})

	it('treats another 400 as an ordinary failure', async () => {
		const result = await testDecisionConnection(
			conn,
			{},
			{
				fetch: (async () =>
					new Response(JSON.stringify({ error: { message: 'bad json' } }), {
						status: 400,
					})) as typeof fetch,
				readStoredKey: () => null,
			},
		)
		expect(result).toEqual({ ok: false, reason: 'the service answered 400: bad json' })
		expect(explainConnectionFailure(new Error('x'), false)).toContain('could not reach')
	})
})
