import { afterEach, describe, expect, it, vi } from 'vitest'

import {
	ZenCatalogueFormatError,
	ZenCatalogueSourceError,
	type ZenCatalogueSources,
	buildZenCatalogue,
	fetchZenCatalogue,
	findZenCatalogueModel,
	parseZenCatalogue,
} from '../catalogue/index.js'
import { ZenGoProvider, ZenProvider } from '../client.js'
import { ZEN_OMITTED_MODELS, findZenModel, getZenModels } from '../models.js'

const ZEN_HOST = 'https://opencode.ai/zen/v1'
const GO_HOST = 'https://opencode.ai/zen/go/v1'
const CHAT = '@ai-sdk/openai-compatible'
const MESSAGES = '@ai-sdk/anthropic'

const row = (host: string, name: string, id: string, path: string, npm: string) =>
	`| ${name} | ${id} | \`${host}${path}\` | \`${npm}\` |`

const ZEN_PAGE = [
	'| Model | Model ID | Endpoint | AI SDK Package |',
	'| --- | --- | --- | --- |',
	row(ZEN_HOST, 'Alpha Chat', 'alpha-chat', '/chat/completions', CHAT),
	row(ZEN_HOST, 'Beta Messages', 'beta-messages', '/messages', MESSAGES),
	row(ZEN_HOST, 'Gamma Free', 'gamma-free', '/chat/completions', CHAT),
	'',
	'| Model | Input | Output | Cached Read |',
	'| --- | --- | --- | --- |',
	'| Alpha Chat | $1.50 | $6.00 | $0.15 |',
	'| Beta Messages | $3.00 | $15.00 | $0.30 |',
	'',
	'The free models:',
	'',
	'- Gamma Free is available on OpenCode for a limited time.',
	'',
].join('\n')

const GO_PAGE = [
	'| Model | Model ID | Endpoint | AI SDK Package |',
	'| --- | --- | --- | --- |',
	row(GO_HOST, 'Go Chat', 'go-chat', '/chat/completions', CHAT),
	'',
	'| Model | Input | Output | Cached Read |',
	'| --- | --- | --- | --- |',
	'| Go Chat | $1.00 | $2.00 | $0.10 |',
	'',
].join('\n')

const entry = (context: number, output: number, input: string[], tools = true) => ({
	limit: { context, output },
	modalities: { input },
	tool_call: tools,
})

const MODELS_DEV = {
	opencode: {
		models: {
			'alpha-chat': {
				...entry(200_000, 64_000, ['text', 'pdf']),
				reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
			},
			'beta-messages': entry(1_000_000, 128_000, ['text', 'image']),
			'gamma-free': entry(262_144, 131_072, ['text'], false),
		},
	},
	'opencode-go': { models: { 'go-chat': entry(131_072, 32_768, ['text']) } },
}

const served = (ids: string[]) =>
	JSON.stringify({
		object: 'list',
		data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
	})

function sources(overrides: Partial<ZenCatalogueSources> = {}): ZenCatalogueSources {
	return {
		docs: { zen: ZEN_PAGE, go: GO_PAGE },
		modelsDev: JSON.stringify(MODELS_DEV),
		served: {
			zen: served(['alpha-chat', 'beta-messages', 'gamma-free', 'hidden-model']),
			go: served(['go-chat']),
		},
		...overrides,
	}
}

/** A fixture carries a handful of models; the bundled snapshot's floor is not its business. */
const FIXTURE = { omissions: [] as string[], baseline: { zen: [], go: [] } }
const build = (input = sources()) =>
	buildZenCatalogue(input, {
		omissions: new Set(FIXTURE.omissions),
		baseline: FIXTURE.baseline,
		fetchedAt: new Date('2026-09-22T00:00:00.000Z'),
	})

afterEach(() => {
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

const NAME_REFUSED = /control,\n {2}format or separator character/

describe('buildZenCatalogue', () => {
	it('derives models in exactly the shape the bundled snapshot carries', () => {
		const { catalogue } = build()
		expect(catalogue.zen).toEqual([
			{
				id: 'alpha-chat',
				name: 'Alpha Chat',
				protocol: 'chat',
				contextWindow: 200_000,
				maxOutputTokens: 64_000,
				inputModalities: ['text', 'document'],
				inputPrice: 1.5,
				outputPrice: 6,
				supportsToolUse: true,
				supportsStreaming: true,
				effortLevels: ['low', 'high'],
			},
			{
				id: 'beta-messages',
				name: 'Beta Messages',
				protocol: 'messages',
				contextWindow: 1_000_000,
				maxOutputTokens: 128_000,
				inputModalities: ['text', 'image'],
				inputPrice: 3,
				outputPrice: 15,
				supportsToolUse: true,
				supportsStreaming: true,
				effortLevels: [],
			},
			{
				id: 'gamma-free',
				supportsAnonymousAccess: true,
				name: 'Gamma Free',
				protocol: 'chat',
				contextWindow: 262_144,
				maxOutputTokens: 131_072,
				inputModalities: ['text'],
				inputPrice: 0,
				outputPrice: 0,
				supportsToolUse: false,
				supportsStreaming: true,
				effortLevels: [],
			},
		])
		// Key for key, a derived entry spells what a bundled one spells.
		const bundled = findZenModel('zen', 'glm-5.3-flash')
		expect(Object.keys(catalogue.zen[1] ?? {}).sort()).toEqual(Object.keys(bundled ?? {}).sort())
		expect(catalogue.fetchedAt).toBe('2026-09-22T00:00:00.000Z')
		expect(Object.isFrozen(catalogue)).toBe(true)
		expect(Object.isFrozen(catalogue.zen[0])).toBe(true)
	})

	it('names a served id it cannot route, and guesses no wire for it', () => {
		const { catalogue, report } = build()
		expect(catalogue.zen.some((model) => model.id === 'hidden-model')).toBe(false)
		expect(catalogue.unrouted).toEqual({ zen: ['hidden-model'], go: [] })
		expect(report.servedUndocumented).toEqual(['zen/hidden-model'])
	})

	it('honours the bundled review decisions by default', () => {
		const omitted = ZEN_OMITTED_MODELS.find((key) => key.startsWith('zen/'))
		expect(omitted).toBeDefined()
		const id = (omitted as string).slice('zen/'.length)
		const withOmitted = sources({
			served: {
				zen: served(['alpha-chat', 'beta-messages', 'gamma-free', id]),
				go: served(['go-chat']),
			},
		})
		const { catalogue } = buildZenCatalogue(withOmitted, { baseline: FIXTURE.baseline })
		expect(catalogue.unrouted.zen).not.toContain(id)
	})

	it.each([
		[
			'a route row the rules no longer read',
			sources({
				docs: {
					zen: `${ZEN_PAGE}\n| Odd | odd_id | \`${ZEN_HOST}/messages\` | \`${MESSAGES}\` |\n`,
					go: GO_PAGE,
				},
			}),
			/did not read as one/,
		],
		['a models.dev that is not JSON', sources({ modelsDev: '<html>502</html>' }), /not JSON/],
		[
			'a models.dev missing a provider',
			sources({ modelsDev: JSON.stringify({ opencode: MODELS_DEV.opencode }) }),
			/opencode-go/,
		],
		[
			'a served answer with no ids',
			sources({ served: { zen: served([]), go: served(['go-chat']) } }),
			/lists no models at all/,
		],
		[
			'a hostile endpoint cell',
			sources({
				docs: {
					zen: ZEN_PAGE.replace(`${ZEN_HOST}/messages`, 'https://evil.example/messages'),
					go: GO_PAGE,
				},
			}),
			/host is not the service/,
		],
		[
			'an effort level the SDK cannot send',
			sources({
				modelsDev: JSON.stringify({
					...MODELS_DEV,
					opencode: {
						models: {
							...MODELS_DEV.opencode.models,
							'alpha-chat': {
								...MODELS_DEV.opencode.models['alpha-chat'],
								reasoning_options: [{ type: 'effort', values: ['turbo'] }],
							},
						},
					},
				}),
			}),
			/turbo/,
		],
	])('refuses the whole result on %s, never a partial list', (_why, input, message) => {
		expect(() => build(input)).toThrow(ZenCatalogueSourceError)
		expect(() => build(input)).toThrow(message)
	})

	it.each([
		['an escape sequence', 'Alpha\x1b]52;c;aGk=\x07\x1b[2J Chat', NAME_REFUSED],
		['a C1 control', 'Alpha\u009b2J Chat', NAME_REFUSED],
		['a bidi override', 'Alpha \u202eChat', NAME_REFUSED],
		// `.` stops at U+2028, so this row is refused as one the rules cannot read.
		['a line separator', 'Alpha\u2028Chat', /shaped like a route row/],
	])('refuses a route row whose model name carries %s', (_why, name, message) => {
		const input = sources({
			docs: {
				zen: ZEN_PAGE.replace('| Alpha Chat | alpha-chat', `| ${name} | alpha-chat`),
				go: GO_PAGE,
			},
		})
		expect(() => build(input)).toThrow(ZenCatalogueSourceError)
		expect(() => build(input)).toThrow(message)
	})

	it('carries no bundled model whose name a terminal would interpret', () => {
		for (const service of ['zen', 'go'] as const) {
			for (const model of getZenModels(service)) {
				expect(model.name).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u)
			}
		}
	})

	it('refuses a roster that collapsed past the floor of its baseline', () => {
		expect(() =>
			buildZenCatalogue(sources(), {
				baseline: { zen: Array.from({ length: 10 }), go: [] },
			}),
		).toThrow(/past the floor/)
		// The default baseline is the bundled snapshot.
		expect(() => buildZenCatalogue(sources())).toThrow(/past the floor/)
	})
})

describe('parseZenCatalogue', () => {
	it('round-trips what JSON.stringify wrote', () => {
		const { catalogue } = build()
		const restored = parseZenCatalogue(JSON.parse(JSON.stringify(catalogue)))
		expect(restored).toEqual(catalogue)
		expect(Object.isFrozen(restored.go[0])).toBe(true)
	})

	it.each([
		['another version', (c: Record<string, unknown>) => ({ ...c, version: 2 })],
		['an unknown field', (c: Record<string, unknown>) => ({ ...c, extra: true })],
		['a bad timestamp', (c: Record<string, unknown>) => ({ ...c, fetchedAt: 'yesterday' })],
		['an empty service', (c: Record<string, unknown>) => ({ ...c, go: [] })],
		[
			'an unknown protocol',
			(c: Record<string, unknown>) => ({
				...c,
				zen: (c.zen as object[]).map((m, i) => (i === 0 ? { ...m, protocol: 'grpc' } : m)),
			}),
		],
		[
			'anonymous access on go',
			(c: Record<string, unknown>) => ({
				...c,
				go: (c.go as object[]).map((m) => ({ ...m, supportsAnonymousAccess: true })),
			}),
		],
		[
			'a repeated id',
			(c: Record<string, unknown>) => ({
				...c,
				zen: [...(c.zen as object[]), (c.zen as object[])[0]],
			}),
		],
		[
			'a negative price',
			(c: Record<string, unknown>) => ({
				...c,
				zen: (c.zen as object[]).map((m, i) => (i === 1 ? { ...m, inputPrice: -1 } : m)),
			}),
		],
		[
			'a name carrying an escape sequence',
			(c: Record<string, unknown>) => ({
				...c,
				zen: (c.zen as object[]).map((m, i) =>
					i === 0 ? { ...m, name: 'Alpha\x1b]52;c;aGk=\x07 Chat' } : m,
				),
			}),
		],
		[
			'an unrouted id that is carried',
			(c: Record<string, unknown>) => ({ ...c, unrouted: { zen: ['alpha-chat'], go: [] } }),
		],
	])('refuses a stored catalogue with %s', (_why, tamper) => {
		const stored = JSON.parse(JSON.stringify(build().catalogue)) as Record<string, unknown>
		expect(() => parseZenCatalogue(tamper(stored))).toThrow(ZenCatalogueFormatError)
	})

	it('refuses what is not an object at all', () => {
		expect(() => parseZenCatalogue(null)).toThrow(ZenCatalogueFormatError)
		expect(() => parseZenCatalogue([])).toThrow(ZenCatalogueFormatError)
	})
})

const HEALTHY: Record<string, () => Response | Promise<Response>> = {
	'/zen.mdx': () => new Response(ZEN_PAGE),
	'/go.mdx': () => new Response(GO_PAGE),
	'/api.json': () => new Response(JSON.stringify(MODELS_DEV)),
	'/zen/v1/models': () => new Response(sources().served.zen),
	'/zen/go/v1/models': () => new Response(sources().served.go),
}

/** A fetch that answers each source URL from a table: every source healthy, bar the overrides. */
function upstream(
	overrides: Record<string, () => Response | Promise<Response>> = {},
	base: Record<string, () => Response | Promise<Response>> = HEALTHY,
): ReturnType<typeof vi.fn<typeof fetch>> {
	const answers = { ...base, ...overrides }
	return vi.fn<typeof fetch>(async (input) => {
		const url = String(input)
		for (const [suffix, answer] of Object.entries(answers)) {
			if (url.endsWith(suffix)) return answer()
		}
		return new Response('not here', { status: 404 })
	})
}

const healthy = () => upstream()

describe('fetchZenCatalogue', () => {
	it('reads the five sources, refusing redirects, and derives the catalogue', async () => {
		const fetchFn = healthy()
		const { catalogue } = await fetchZenCatalogue({ fetch: fetchFn, baseline: FIXTURE.baseline })
		expect(catalogue.zen.map((model) => model.id)).toEqual([
			'alpha-chat',
			'beta-messages',
			'gamma-free',
		])
		expect(fetchFn).toHaveBeenCalledTimes(5)
		expect(fetchFn.mock.calls.map(([url]) => String(url)).sort()).toEqual([
			'https://models.dev/api.json',
			'https://opencode.ai/zen/go/v1/models',
			'https://opencode.ai/zen/v1/models',
			'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/go.mdx',
			'https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/web/src/content/docs/zen.mdx',
		])
		for (const [, init] of fetchFn.mock.calls) expect(init?.redirect).toBe('error')
	})

	it('rejects when a source is unreachable, with no partial result', async () => {
		const fetchFn = upstream({ '/api.json': () => Promise.reject(new TypeError('fetch failed')) })
		await expect(fetchZenCatalogue({ fetch: fetchFn })).rejects.toThrow(ZenCatalogueSourceError)
		await expect(fetchZenCatalogue({ fetch: fetchFn })).rejects.toThrow(/fetch failed/)
	})

	it('refuses an oversized source by its declared length and by what it streams', async () => {
		const declared = upstream({
			'/api.json': () =>
				new Response('{}', { headers: { 'content-length': String(64 * 1024 * 1024) } }),
		})
		await expect(
			fetchZenCatalogue({ fetch: declared, limits: { modelsDevBytes: 1024 } }),
		).rejects.toThrow(/limit/)

		const cancel = vi.fn()
		const streamed = upstream({
			'/zen.mdx': () =>
				new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(2048))
						},
						cancel,
					}),
				),
		})
		await expect(
			fetchZenCatalogue({ fetch: streamed, limits: { pageBytes: 1024 } }),
		).rejects.toThrow(/exceeds its 1024-byte limit/)
		expect(cancel).toHaveBeenCalled()
	})

	it('gives up on a source that does not answer inside its deadline', async () => {
		const hanging = vi.fn<typeof fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
				}),
		)
		const started = Date.now()
		await expect(fetchZenCatalogue({ fetch: hanging, timeoutMs: 50 })).rejects.toThrow(
			ZenCatalogueSourceError,
		)
		expect(Date.now() - started).toBeLessThan(2_000)
	})

	it('does not retry a 404, and rejects with the caller’s reason on abort', async () => {
		const missing = upstream({}, {})
		await expect(fetchZenCatalogue({ fetch: missing, attempts: 3 })).rejects.toThrow(/404/)
		const controller = new AbortController()
		controller.abort(new Error('launch ended'))
		await expect(
			fetchZenCatalogue({ fetch: healthy(), signal: controller.signal }),
		).rejects.toThrow('launch ended')
	})
})

describe('ZenProvider with a runtime catalogue', () => {
	const runtime = () => {
		const { catalogue } = build(
			sources({
				served: {
					zen: served(['alpha-chat', 'beta-messages', 'gamma-free', 'hidden-model']),
					go: served(['go-chat', 'go-hidden']),
				},
			}),
		)
		return catalogue
	}
	const params = { model: '', messages: [{ role: 'user' as const, content: 'Hello' }] }

	async function drain(stream: AsyncIterable<unknown>): Promise<void> {
		for await (const _ of stream) {
		}
	}

	it('routes a model only the runtime catalogue carries, on the wire it states', async () => {
		const transport = vi.fn<typeof fetch>(async () => new Response('{}', { status: 400 }))
		vi.stubGlobal('fetch', transport)
		expect(findZenModel('zen', 'beta-messages')).toBeUndefined()
		const provider = new ZenProvider({ apiKey: 'fixture', catalogue: runtime() })
		await expect(
			drain(provider.chatStream({ ...params, model: 'beta-messages' })),
		).rejects.toThrow()
		expect(String(transport.mock.calls[0]?.[0])).toBe(`${ZEN_HOST}/messages`)
		expect(await provider.resolveContextWindow('beta-messages')).toBe(1_000_000)
	})

	it('prefers the runtime entry over the bundled one, and falls back to the bundled one', async () => {
		const bundled = findZenModel('zen', 'glm-5.3-flash')
		expect(bundled).toBeDefined()
		const base = runtime()
		const catalogue = {
			...base,
			zen: [...base.zen, { ...(bundled as NonNullable<typeof bundled>), contextWindow: 4096 }],
		}
		const provider = new ZenProvider({ apiKey: 'fixture', catalogue })
		expect(await provider.resolveContextWindow('glm-5.3-flash')).toBe(4096)
		const other = getZenModels('zen').find((model) => model.id !== 'glm-5.3-flash')
		expect(await provider.resolveContextWindow(other?.id ?? '')).toBe(other?.contextWindow)
		expect(findZenCatalogueModel(undefined, 'zen', 'glm-5.3-flash')).toBe(bundled)
	})

	it('reads a catalogue function at every lookup, so a fresher one reaches a built provider', async () => {
		const holder: { current?: ReturnType<typeof runtime> } = {}
		const provider = new ZenProvider({ apiKey: 'fixture', catalogue: () => holder.current })
		expect(await provider.resolveContextWindow('beta-messages')).toBeUndefined()
		holder.current = runtime()
		expect(await provider.resolveContextWindow('beta-messages')).toBe(1_000_000)
	})

	it('lists an unrouted served id as having no known wire format, and never anonymously', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(
				async () => new Response(served(['go-chat', 'go-hidden', 'never-heard-of'])),
			),
		)
		const provider = new ZenGoProvider({ apiKey: 'fixture', catalogue: runtime() })
		const listed = await provider.listModels()
		expect(listed.map((model) => model.id)).toEqual(['go-chat', 'go-hidden'])
		expect(listed[1]).toEqual({
			id: 'go-hidden',
			name: 'go-hidden (no known wire format)',
			supportsToolUse: false,
			supportsStreaming: true,
		})

		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async () => new Response(served(['gamma-free', 'hidden-model']))),
		)
		const anonymous = new ZenProvider({ catalogue: runtime() })
		expect((await anonymous.listModels()).map((model) => model.id)).toEqual(['gamma-free'])
	})

	it('calls an unrouted id only with an explicit protocol, never on a guessed one', async () => {
		const transport = vi.fn<typeof fetch>(async () => new Response('{}', { status: 400 }))
		vi.stubGlobal('fetch', transport)
		const guessed = new ZenProvider({ apiKey: 'fixture', catalogue: runtime() })
		await expect(
			drain(guessed.chatStream({ ...params, model: 'hidden-model' })),
		).rejects.toMatchObject({
			kind: 'bad_request',
			detail: expect.stringContaining('no source states its wire format'),
		})
		expect(transport).not.toHaveBeenCalled()

		const stated = new ZenProvider({
			apiKey: 'fixture',
			catalogue: runtime(),
			protocol: 'responses',
		})
		await expect(drain(stated.chatStream({ ...params, model: 'hidden-model' }))).rejects.toThrow()
		expect(String(transport.mock.calls[0]?.[0])).toBe(`${ZEN_HOST}/responses`)
	})

	it('does not let the bundled snapshot answer for an id the runtime catalogue names unrouted', async () => {
		// The case the runtime catalogue exists for: upstream stopped stating a
		// wire for a model the bundled snapshot still carries, and the service
		// still serves it. The old entry must not route it, anonymously or not.
		const bundled = getZenModels('zen').find((model) => model.supportsAnonymousAccess === true)
		expect(bundled).toBeDefined()
		const id = (bundled as NonNullable<typeof bundled>).id
		const { catalogue } = build(
			sources({
				served: {
					zen: served(['alpha-chat', 'beta-messages', 'gamma-free', id]),
					go: served(['go-chat']),
				},
			}),
		)
		expect(catalogue.unrouted.zen).toContain(id)
		expect(findZenCatalogueModel(catalogue, 'zen', id)).toBeUndefined()
		expect(findZenCatalogueModel(undefined, 'zen', id)).toBe(bundled)

		const transport = vi.fn<typeof fetch>(async () => new Response(served([id])))
		vi.stubGlobal('fetch', transport)
		const anonymous = new ZenProvider({ catalogue })
		await expect(drain(anonymous.chatStream({ ...params, model: id }))).rejects.toMatchObject({
			kind: 'auth',
		})
		const keyed = new ZenProvider({ apiKey: 'fixture', catalogue })
		await expect(drain(keyed.chatStream({ ...params, model: id }))).rejects.toMatchObject({
			kind: 'bad_request',
			detail: expect.stringContaining('no source states its wire format'),
		})
		expect(transport).not.toHaveBeenCalled()
		expect(await keyed.listModels()).toEqual([
			{
				id,
				name: `${id} (no known wire format)`,
				supportsToolUse: false,
				supportsStreaming: true,
			},
		])
		expect(await keyed.resolveContextWindow(id)).toBeUndefined()
	})

	it('refuses a catalogue option that is neither a catalogue nor a function', () => {
		expect(
			() => new ZenProvider({ catalogue: 'fresh' as unknown as ReturnType<typeof runtime> }),
		).toThrow(/catalogue must be/)
	})
})

describe('no network by default', () => {
	it('fetches nothing to construct, look up, derive or re-admit a catalogue', async () => {
		const transport = vi.fn<typeof fetch>(async () => {
			throw new Error('unexpected network call')
		})
		vi.stubGlobal('fetch', transport)
		await import('@namzu/sdk')
		await import('../index.js')
		await import('../catalogue/index.js')
		const anonymous = new ZenProvider()
		const keyed = new ZenGoProvider({ apiKey: 'fixture' })
		getZenModels('zen')
		findZenModel('go', 'glm-5.3-flash')
		await anonymous.resolveContextWindow('glm-5.3-flash')
		keyed.reasoningEffortLevelsFor('glm-5.3-flash')
		parseZenCatalogue(JSON.parse(JSON.stringify(build().catalogue)))
		new ZenProvider({ apiKey: 'fixture', catalogue: build().catalogue })
		expect(transport).not.toHaveBeenCalled()
	})
})
