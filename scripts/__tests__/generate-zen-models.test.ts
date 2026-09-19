/**
 * Tests for scripts/generate-zen-models.mjs.
 *
 * Uses `node:test` and `node:assert/strict` rather than vitest, for the reason
 * scripts/__tests__/check-log-standard.test.ts sets out: this file has no
 * package of its own, and every vitest config in the tree is scoped to one
 * package's `src/`. Run via
 * `node --import tsx --test scripts/__tests__/generate-zen-models.test.ts`,
 * which is also how the CI gate runs it.
 *
 * Everything here is hermetic. The derivation rules are exercised against
 * synthetic pages and a synthetic models.dev document; the end-to-end cases
 * drive the built script with `--from`, which reads the pages, models.dev and
 * the two `/models` answers out of the fixture directory; and the one case that
 * has to exercise the FETCH binds a server on loopback and points the script at
 * it through the environment, so nothing here reaches the public network. The
 * fixture pages are small on purpose and shaped like the real ones where the
 * shape is the thing being relied on — a test that copied 27KB of upstream
 * prose would prove the prose, not the parsing.
 *
 * No test runs the script without `--check` unless the fixture it points at is
 * one its own sources derive, because a refresh in disagreement writes
 * packages/providers/zen/src/models.ts and this file is also picked up by the
 * root `pnpm test:scripts` glob. The two refresh cases say so where they stand.
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
	checkRosterFloor,
	derive,
	describeChanges,
	formatted,
	isRouteRowShaped,
	parsePage,
	parseRendered,
	parseServed,
	priceCell,
	priceRowFor,
	protocolFor,
	render,
	renderEntry,
} from '../generate-zen-models.mjs'

/** The shape `renderEntry` takes; the script itself is untyped JavaScript. */
interface RenderedModel {
	id: string
	name: string
	protocol: string
	contextWindow: number
	maxOutputTokens: number
	inputModalities: string[]
	inputPrice: number
	outputPrice: number
	supportsToolUse: boolean
	effortLevels: string[]
	supportsAnonymousAccess: boolean
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(ROOT, 'scripts', 'generate-zen-models.mjs')

const paths: string[] = []
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-zen-catalogue-'))
	paths.push(dir)
	return dir
}
after(() => {
	for (const dir of paths) rmSync(dir, { recursive: true, force: true })
})

// The hosts are interpolated rather than written out, which keeps every
// fixture line free of `//` — the external-name audit reads a line containing
// one as prose and stops stripping its literals, and these fixtures are wire
// values rather than prose. Naming the host once also reads better than ten
// copies of it.
const ZEN_HOST = 'https://opencode.ai/zen/v1'
const GO_HOST = 'https://opencode.ai/zen/go/v1'

/** One route-table row, so a test that edits the table edits it in one place. */
function routeRow(host: string, name: string, id: string, path: string, npm: string): string {
	return `| ${name} | ${id} | \`${host}${path}\` | \`${npm}\` |`
}

/**
 * The other route-row shape the page publishes: the same row with the package
 * column carrying the dash the pages give a cell that has no value, which is a
 * model routed and no wire stated for it.
 */
function wirelessRow(host: string, name: string, id: string, path: string): string {
	return `| ${name} | ${id} | \`${host}${path}\` | - |`
}

const CHAT = '@ai-sdk/openai-compatible'
const RESPONSES = '@ai-sdk/openai'
const MESSAGES = '@ai-sdk/anthropic'
const GOOGLE = '@ai-sdk/google'

/** One page carrying every shape this script depends on, in the real positions. */
const ZEN_PAGE = [
	'## Endpoints',
	'',
	'| Model | Model ID | Endpoint | AI SDK Package |',
	'| --- | --- | --- | --- |',
	routeRow(ZEN_HOST, 'Alpha Chat', 'alpha-chat', '/chat/completions', CHAT),
	routeRow(ZEN_HOST, 'Beta Responses', 'beta-responses', '/responses', RESPONSES),
	routeRow(ZEN_HOST, 'Gemini Think', 'gemini-think', '/models/gemini-think', GOOGLE),
	routeRow(ZEN_HOST, 'Gamma Free', 'gamma-free', '/chat/completions', CHAT),
	routeRow(ZEN_HOST, 'Delta Undocumented', 'delta-undocumented', '/chat/completions', CHAT),
	'',
	'## Pricing',
	'',
	'| Model | Input | Output | Cached Read |',
	'| --- | --- | --- | --- |',
	'| Alpha Chat (≤ 200K tokens) | $1.50 | $6.00 | $0.15 |',
	'| Alpha Chat (> 200K tokens) | $3.00 | $12.00 | $0.30 |',
	'| Beta Responses | $10.00 | $50.00 | $1.00 |',
	'| Gemini Think | $1.50 | $7.50 | $0.15 |',
	'',
	'The free models:',
	'',
	'- Gamma Free is available on OpenCode for a limited time. The team is using this time to collect feedback and improve the model.',
	'',
	'<a href={email}>Contact us</a> if you have any questions.',
	'',
	'- Gamma Free: During its free period, collected data may be used to improve the model.',
	'- Nemotron 3 Ultra Free (NVIDIA free endpoints): Trial use only — do not submit personal or confidential data. Your use is logged for security purposes.',
	'',
].join('\n')

/** The same page with every documented model carried, which is not the committed one. */
const ZEN_PAGE_DECIDED = ZEN_PAGE.replace(/^\| Delta Undocumented.*\n/m, '')

const GO_PAGE = [
	'| Model | Model ID | Endpoint | AI SDK Package |',
	'| --- | --- | --- | --- |',
	routeRow(GO_HOST, 'Go Chat', 'go-chat', '/chat/completions', CHAT),
	'',
	'| Model | Input | Output | Cached Read |',
	'| --- | --- | --- | --- |',
	'| Go Chat | $1.00 | $2.00 | $0.10 |',
	'',
].join('\n')

const MODELS_DEV = {
	opencode: {
		id: 'opencode',
		npm: '@ai-sdk/openai-compatible',
		models: {
			'alpha-chat': {
				limit: { context: 200000, output: 64000 },
				modalities: { input: ['text', 'pdf'] },
				tool_call: true,
				reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
			},
			'beta-responses': {
				limit: { context: 1050000, output: 128000 },
				modalities: { input: ['text', 'image', 'video'] },
				tool_call: true,
				reasoning_options: [{ type: 'toggle' }],
			},
			'gemini-think': {
				limit: { context: 1048576, output: 65536 },
				modalities: { input: ['text', 'audio'] },
				tool_call: true,
			},
			'gamma-free': {
				limit: { context: 262144, output: 131072 },
				modalities: { input: ['text'] },
				tool_call: false,
			},
		},
	},
	'opencode-go': {
		id: 'opencode-go',
		npm: '@ai-sdk/openai-compatible',
		models: {
			'go-chat': {
				limit: { context: 131072, output: 32768 },
				modalities: { input: ['text'] },
				tool_call: true,
			},
		},
	},
}

function zenPage(text = ZEN_PAGE) {
	return parsePage(text, { page: 'zen.mdx', service: 'zen' })
}

/**
 * The ids a fixture page routes, which is what the service serves in every case
 * that is not about the served dimension — and `undefined` for a page built to
 * make the parser fail, which has no roster to state.
 */
function routedIds(text: string, service: 'zen' | 'go'): string[] | undefined {
	try {
		return parsePage(text, { page: `${service}.mdx`, service }).routes.map(
			(row: { id: string }) => row.id,
		)
	} catch {
		return undefined
	}
}

/** One `/models` answer, shaped like the service's: a `data` array of ids. */
function catalogue(ids: string[]): object {
	return {
		object: 'list',
		data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'opencode' })),
	}
}

/** What the two fixture services serve: every id their pages route. */
const ZEN_SERVED = new Set(routedIds(ZEN_PAGE, 'zen') ?? [])
const GO_SERVED = new Set(routedIds(GO_PAGE, 'go') ?? [])

/**
 * The same, for the page whose documented models are all carried — the roster a
 * test starts from when it wants to add one served-but-undocumented id to it.
 */
const DECIDED_SERVED = routedIds(ZEN_PAGE_DECIDED, 'zen') ?? []

/**
 * A module the fixture is expected to agree with: the roster its own sources
 * derive. `--from` replaces the file under test as well as the sources, so a
 * test can drive the agreement path — and the disagreement path — without ever
 * touching the real `models.ts`.
 *
 * Best-effort by design: a fixture built to make the derivation FAIL has no
 * baseline to compute, and an empty one is honest — the roster floor is
 * skipped when nothing is committed, and the failure under test arrives before
 * the comparison anyway.
 */
function baselineFor(zen: string, modelsDev: typeof MODELS_DEV, omissions: Record<string, string>) {
	try {
		const z = derive(
			'zen',
			zenPage(zen),
			'opencode',
			modelsDev.opencode,
			omissions,
			// The served roster never changes a carried model, so the baseline —
			// which is only the roster — is derived without one.
			new Set<string>(),
		).models
		const g = derive(
			'go',
			parsePage(GO_PAGE, { page: 'go.mdx', service: 'go' }),
			'opencode-go',
			modelsDev['opencode-go'],
			{},
			new Set<string>(),
		).models
		// Through the same formatter the check runs, or the comparison would be
		// against a spelling the gate never produces.
		return formatted(render({ zen: z, go: g }, '2026-01-01'))
	} catch {
		return '// these sources do not derive; the module is not the thing under test\n'
	}
}

function fixtureDir(
	zen = ZEN_PAGE,
	modelsDev = MODELS_DEV,
	omissions: Record<string, string> = {},
	baseline?: string,
	served: { zen?: string[]; go?: string[] } = {},
): string {
	const dir = tempDir()
	writeFileSync(join(dir, 'zen.mdx'), zen)
	writeFileSync(join(dir, 'go.mdx'), GO_PAGE)
	writeFileSync(join(dir, 'models.dev.json'), JSON.stringify(modelsDev))
	// `--from` replaces the review file and the module too, so a test never
	// touches either real one.
	writeFileSync(join(dir, 'models.review.json'), JSON.stringify({ omissions }))
	writeFileSync(join(dir, 'models.ts'), baseline ?? baselineFor(zen, modelsDev, omissions))
	// The two `/models` answers travel with the pages, so every test that does
	// not say otherwise is hermetic end to end. The default is the honest one:
	// the service serves what its page routes. A page the fixture cannot parse
	// has no roster to state, and the canonical page's ids stand in — the tests
	// that use such a page are about the parser and need the run to reach it.
	writeFileSync(
		join(dir, 'served.zen.json'),
		JSON.stringify(catalogue(served.zen ?? routedIds(zen, 'zen') ?? [...ZEN_SERVED])),
	)
	writeFileSync(
		join(dir, 'served.go.json'),
		JSON.stringify(catalogue(served.go ?? routedIds(GO_PAGE, 'go') ?? [...GO_SERVED])),
	)
	return dir
}

/**
 * The same fixture with the served roster deliberately absent, so the run
 * fetches it — the only arrangement in which `NAMZU_ZEN_MODELS_BASE` is what
 * decides where the served dimension comes from.
 */
function fixtureWithoutServedRoster(zen = ZEN_PAGE_DECIDED): string {
	const dir = fixtureDir(zen)
	rmSync(join(dir, 'served.zen.json'))
	rmSync(join(dir, 'served.go.json'))
	return dir
}

function run(args: string[]) {
	return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
}

/**
 * The script as a child process whose environment this test sets.
 *
 * Asynchronous on purpose: the server the served-dimension test talks to lives
 * in THIS process, and a synchronous spawn would block the loop that has to
 * answer it — the request would sit until the script's own timeout and the test
 * would prove nothing but the timeout.
 */
function runAsync(
	args: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [SCRIPT, ...args], {
			cwd: ROOT,
			env: { ...process.env, ...env },
		})
		let stdout = ''
		let stderr = ''
		child.stdout.on('data', (chunk) => {
			stdout += String(chunk)
		})
		child.stderr.on('data', (chunk) => {
			stderr += String(chunk)
		})
		child.on('error', reject)
		child.on('close', (status) => resolve({ status, stdout, stderr }))
	})
}

describe('parsePage', () => {
	test('reads the route table, the price table and the free list', () => {
		const parsed = zenPage()
		assert.deepEqual(
			parsed.routes.map((row: { id: string }) => row.id),
			['alpha-chat', 'beta-responses', 'gemini-think', 'gamma-free', 'delta-undocumented'],
		)
		assert.equal(parsed.routes[1].npm, RESPONSES)
		assert.equal(parsed.prices.length, 4)
		assert.deepEqual(parsed.freeNames, ['Gamma Free'])
	})

	/**
	 * The regression this file exists for as much as any other: the same page
	 * ends with per-model data-handling notes that are also bullets and also
	 * name models. Reading those as free models would widen anonymous access
	 * silently, which is the one thing the free list is not allowed to do.
	 *
	 * The fixture has to be adversarial for this to mean anything, and the
	 * assertion below states the adversary: the notes bullet is shaped exactly
	 * like a free-model bullet, so a scan that did not stop at the end of the
	 * section would read it. Measured — with the section terminator removed,
	 * `freeNames` comes back with a second entry and this test fails.
	 */
	test('does not read the data-handling notes as free models', () => {
		const parsed = zenPage()
		const bulletShaped = ZEN_PAGE.split('\n').filter((line) => /^-\s+(.+?)\s+is\s/.test(line))
		assert.ok(
			bulletShaped.length > 1,
			'the fixture must carry a notes bullet a section-less scan would read, or this proves nothing',
		)
		assert.deepEqual(parsed.freeNames, ['Gamma Free'])
	})

	test('stops the free-model list at the next heading', () => {
		const page = ZEN_PAGE.replace(
			'<a href={email}>Contact us</a> if you have any questions.',
			'## Data handling\n',
		)
		assert.deepEqual(zenPage(page).freeNames, ['Gamma Free'])
	})

	test('refuses a page with no route table', () => {
		assert.throws(
			() => zenPage('# Zen\n\nNothing here.\n'),
			/no route table/,
		)
	})

	test('refuses a zen page with no free-model list', () => {
		const page = ZEN_PAGE.replace(/^The free models:$/m, 'Somewhere else entirely:')
		assert.throws(() => zenPage(page), /no free-model list/)
	})
})

describe('parseServed', () => {
	test('reads the ids one /models answer carries', () => {
		assert.deepEqual(
			[...parseServed('zen', JSON.stringify(catalogue(['alpha-chat', 'gamma-free'])))],
			['alpha-chat', 'gamma-free'],
		)
	})

	/**
	 * The served roster is the one source whose ABSENCE would look like
	 * agreement: an answer read as "nothing is served" makes every id in it
	 * vanish from the check while the run reports success. So nothing about a
	 * malformed answer is tolerated.
	 */
	test('refuses an answer that is not JSON, or has no data array', () => {
		assert.throws(() => parseServed('zen', '<html>502 Bad Gateway</html>'), /is not JSON/)
		assert.throws(() => parseServed('zen', JSON.stringify({ object: 'list' })), /no `data` array/)
		assert.throws(() => parseServed('zen', JSON.stringify({ data: {} })), /no `data` array/)
	})

	test('refuses an answer with no ids in it', () => {
		assert.throws(
			() => parseServed('go', JSON.stringify(catalogue([]))),
			/lists no models at all/,
		)
	})

	test('refuses an entry it cannot read an id from', () => {
		assert.throws(
			() => parseServed('zen', JSON.stringify({ data: [{ object: 'model' }] })),
			/no string `id`/,
		)
	})
})

describe('priceCell', () => {
	test('reads a dollar figure and the literal word Free', () => {
		assert.equal(priceCell('$1.50'), 1.5)
		assert.equal(priceCell('$0.15'), 0.15)
		assert.equal(priceCell('Free'), 0)
		assert.equal(priceCell('free'), 0)
	})

	test('reads anything else as not a price, so an unrelated table is not one', () => {
		assert.equal(priceCell('Input'), undefined)
		assert.equal(priceCell('160'), undefined)
		assert.equal(priceCell('**Unlimited**'), undefined)
		assert.equal(priceCell(''), undefined)
	})
})

describe('priceRowFor', () => {
	test('prefers the unqualified row over a tier pair', () => {
		const row = priceRowFor(
			[
				{ name: 'Alpha (≤ 200K tokens)', input: 1.5, output: 6 },
				{ name: 'Alpha', input: 2, output: 8 },
				{ name: 'Alpha (> 200K tokens)', input: 3, output: 12 },
			],
			'Alpha',
		)
		assert.equal(row?.input, 2)
	})

	test('takes the cheap tier of a tier pair', () => {
		const row = priceRowFor(
			[
				{ name: 'Alpha (≤ 200K tokens)', input: 1.5, output: 6 },
				{ name: 'Alpha (> 200K tokens)', input: 3, output: 12 },
			],
			'Alpha',
		)
		assert.equal(row?.input, 1.5)
	})

	test('takes the off-peak row where a model publishes both', () => {
		const row = priceRowFor(
			[
				{ name: 'DeepSeek V4 Flash (Off-Peak)', input: 0.15, output: 0.6 },
				{ name: 'DeepSeek V4 Flash (Peak)', input: 0.3, output: 1.2 },
			],
			'DeepSeek V4 Flash',
		)
		assert.equal(row?.input, 0.15)
	})

	test('matches across the table-to-table spelling drift', () => {
		const row = priceRowFor([{ name: 'MiMo V2.5', input: 0.14, output: 0.28 }], 'MiMo-V2.5')
		assert.equal(row?.input, 0.14)
	})
})

describe('protocolFor', () => {
	test('maps each documented pair', () => {
		const pairs: Array<[string, string, string]> = [
			[CHAT, `${ZEN_HOST}/chat/completions`, 'chat'],
			[RESPONSES, `${ZEN_HOST}/responses`, 'responses'],
			[MESSAGES, `${ZEN_HOST}/messages`, 'messages'],
			[GOOGLE, `${ZEN_HOST}/models/gemini-think`, 'google'],
		]
		for (const [npm, endpoint, protocol] of pairs) {
			assert.equal(protocolFor({ id: 'x', npm, endpoint }, 'zen'), protocol)
		}
	})

	test('refuses a pair that is not one of the routes it implements', () => {
		assert.throws(
			() => protocolFor({ id: 'x', npm: RESPONSES, endpoint: `${ZEN_HOST}/embeddings` }, 'zen'),
			/does not address/,
		)
	})

	/**
	 * The route is the (package, endpoint) PAIR, not either half. A page whose
	 * two columns disagree must stop the run rather than have one half believed.
	 */
	test('refuses a page whose two columns disagree', () => {
		assert.throws(
			() => protocolFor({ id: 'x', npm: MESSAGES, endpoint: `${ZEN_HOST}/responses` }, 'zen'),
			/does not address/,
		)
	})

	/**
	 * The path alone is not the route: a routing decision made on a substring
	 * accepts any host that happens to carry the same path.
	 */
	test('refuses a host that is not the service', () => {
		assert.throws(
			() => protocolFor({ id: 'x', npm: MESSAGES, endpoint: 'https://evil.example/messages' }, 'zen'),
			/host is not the service/,
		)
	})

	test('refuses one service’s endpoint on the other service', () => {
		assert.throws(
			() => protocolFor({ id: 'x', npm: CHAT, endpoint: `${GO_HOST}/chat/completions` }, 'zen'),
			/not on the zen service/,
		)
	})

	test('refuses a model path that is not a model id', () => {
		assert.throws(
			() => protocolFor({ id: 'x', npm: GOOGLE, endpoint: `${ZEN_HOST}/models/../secrets` }, 'zen'),
			/does not address/,
		)
	})
})

describe('derive', () => {
	test('carries a priced model with the metadata models.dev holds', () => {
		const { models } = derive('zen', zenPage(), 'opencode', MODELS_DEV.opencode, {}, ZEN_SERVED)
		const alpha = models.find((m: { id: string }) => m.id === 'alpha-chat')
		assert.deepEqual(alpha, {
			id: 'alpha-chat',
			name: 'Alpha Chat',
			protocol: 'chat',
			contextWindow: 200000,
			maxOutputTokens: 64000,
			inputModalities: ['text', 'document'],
			inputPrice: 1.5,
			outputPrice: 6,
			supportsToolUse: true,
			effortLevels: ['low', 'high'],
			supportsAnonymousAccess: false,
		})
	})

	test('drops audio and video, which the SDK has no input kind for', () => {
		const { models } = derive('zen', zenPage(), 'opencode', MODELS_DEV.opencode, {}, ZEN_SERVED)
		const beta = models.find((m: { id: string }) => m.id === 'beta-responses')
		assert.deepEqual(beta?.inputModalities, ['text', 'image'])
		const googleWire = models.find((m: { id: string }) => m.id === 'gemini-think')
		assert.deepEqual(googleWire?.inputModalities, ['text'])
	})

	test('an effort list is empty where the page advertises no effort selector', () => {
		const { models } = derive('zen', zenPage(), 'opencode', MODELS_DEV.opencode, {}, ZEN_SERVED)
		assert.deepEqual(
			models.find((m: { id: string }) => m.id === 'beta-responses')?.effortLevels,
			[],
		)
	})

	test('prices a free-listed model at zero and marks it anonymous on zen', () => {
		const { models } = derive('zen', zenPage(), 'opencode', MODELS_DEV.opencode, {}, ZEN_SERVED)
		const gamma = models.find((m: { id: string }) => m.id === 'gamma-free')
		assert.equal(gamma?.inputPrice, 0)
		assert.equal(gamma?.outputPrice, 0)
		assert.equal(gamma?.supportsAnonymousAccess, true)
	})

	/** Go refuses an absent key outright, so the flag would mean nothing there. */
	test('never marks a Go model anonymous, though it still prices it at zero', () => {
		const page = [
			routeRow(GO_HOST, 'Go Free', 'go-free', '/chat/completions', CHAT),
			'',
			'The free models:',
			'',
			'- Go Free is available on OpenCode for a limited time.',
			'',
		].join('\n')
		const provider = {
			models: {
				'go-free': {
					limit: { context: 1000, output: 100 },
					modalities: { input: ['text'] },
					tool_call: true,
				},
			},
		}
		const { models } = derive(
			'go',
			parsePage(page, { page: 'go.mdx', service: 'go' }),
			'opencode-go',
			provider,
			{},
			GO_SERVED,
		)
		assert.equal(models[0]?.supportsAnonymousAccess, false)
		assert.equal(models[0]?.inputPrice, 0)
	})

	test('an omission removes the model and reports nothing', () => {
		const { models, undecided, stale } = derive(
			'zen',
			zenPage(ZEN_PAGE_DECIDED),
			'opencode',
			MODELS_DEV.opencode,
			{ 'zen/alpha-chat': 'Superseded by a later generation.' },
			ZEN_SERVED,
		)
		assert.equal(models.some((m: { id: string }) => m.id === 'alpha-chat'), false)
		assert.deepEqual(undecided, [])
		assert.deepEqual(stale, [])
	})

	test('a documented model with no metadata is reported, named by service', () => {
		const { models, undecided } = derive('zen', zenPage(), 'opencode', MODELS_DEV.opencode, {}, ZEN_SERVED)
		assert.equal(models.some((m: { id: string }) => m.id === 'delta-undocumented'), false)
		assert.deepEqual(undecided, [
			['zen/delta-undocumented', 'models.dev has no `opencode` entry'],
		])
	})

	test('a model the page neither prices nor calls free is reported, not defaulted to zero', () => {
		const gamma = routeRow(ZEN_HOST, 'Gamma Free', 'gamma-free', '/chat/completions', CHAT)
		const page = ZEN_PAGE_DECIDED.replace(
			gamma,
			`${gamma}\n${routeRow(ZEN_HOST, 'Epsilon Unpriced', 'epsilon-unpriced', '/chat/completions', CHAT)}`,
		)
		const dev = structuredClone(MODELS_DEV)
		dev.opencode.models['epsilon-unpriced'] = {
			limit: { context: 1000, output: 100 },
			modalities: { input: ['text'] },
			tool_call: true,
		}
		const { models, undecided } = derive('zen', zenPage(page), 'opencode', dev.opencode, {}, ZEN_SERVED)
		assert.equal(models.some((m: { id: string }) => m.id === 'epsilon-unpriced'), false)
		assert.deepEqual(undecided, [
			['zen/epsilon-unpriced', 'the page neither prices it nor names it as free'],
		])
	})

	test('an omission for a model upstream no longer documents is reported as stale', () => {
		const { stale } = derive('zen', zenPage(), 'opencode', MODELS_DEV.opencode, {
			'zen/gone-last-month': 'It was superseded.',
		}, ZEN_SERVED)
		assert.deepEqual(stale, ['gone-last-month'])
	})

	test('an omission for the other service is not this service’s business', () => {
		const { stale } = derive('zen', zenPage(), 'opencode', MODELS_DEV.opencode, {
			'go/only-on-go': 'It was superseded.',
		}, ZEN_SERVED)
		assert.deepEqual(stale, [])
	})

	/**
	 * The id the service serves and no page documents. It cannot be carried — a
	 * wire is stated on a page and nowhere else — so it is reported, and the
	 * report is the only thing standing between it and a driver that silently
	 * never offers it.
	 */
	test('reports an id the service serves that the page does not document', () => {
		const served = new Set([...DECIDED_SERVED, 'gpt-6-unlisted'])
		const { models, servedUncurried } = derive(
			'zen',
			zenPage(ZEN_PAGE_DECIDED),
			'opencode',
			MODELS_DEV.opencode,
			{},
			served,
		)
		assert.equal(models.some((m: { id: string }) => m.id === 'gpt-6-unlisted'), false)
		assert.deepEqual(servedUncurried, ['gpt-6-unlisted'])
	})

	test('an id that is carried or omitted is not reported as uncurried', () => {
		const { servedUncurried } = derive(
			'zen',
			zenPage(ZEN_PAGE_DECIDED),
			'opencode',
			MODELS_DEV.opencode,
			{ 'zen/gpt-6-unlisted': 'Served, documented nowhere, so no wire is derivable.' },
			new Set([...DECIDED_SERVED, 'gpt-6-unlisted']),
		)
		assert.deepEqual(servedUncurried, [])
	})

	/**
	 * An omission expires when upstream stops naming the model at all, and the
	 * page is no longer the only source that says a model exists: an id the
	 * service still answers on `/models` is a model upstream still serves, so a
	 * decision about it has not gone stale.
	 */
	test('an omission for an id the service still serves is not stale', () => {
		const { stale } = derive(
			'zen',
			zenPage(ZEN_PAGE_DECIDED),
			'opencode',
			MODELS_DEV.opencode,
			{ 'zen/gone-last-month': 'Superseded, and the service is expected to keep it.' },
			new Set(['gone-last-month']),
		)
		assert.deepEqual(stale, [])
	})
})

describe('a row the script did not read', () => {
	/**
	 * The gate is all-or-nothing per line, so a line it stops understanding is
	 * a model that leaves the catalogue without anyone being told. Each of
	 * these leaves a row that is plainly a route row and no longer
	 * matches the route pattern; every one of them used to pass in silence.
	 */
	test('stops on a route-row-shaped line it did not capture', () => {
		const rows: Array<[string, string]> = [
			[
				'an id with an underscore',
				routeRow(ZEN_HOST, 'Wandering Model', 'wandering_model', '/chat/completions', CHAT),
			],
			[
				'a trailing space after the final pipe',
				`${routeRow(ZEN_HOST, 'Trail Space', 'trail-space', '/chat/completions', CHAT)} `,
			],
			[
				'an empty package cell',
				`| Empty Pkg | empty-pkg | \`${ZEN_HOST}/chat/completions\` |  |`,
			],
			[
				// The page's own no-value dash is a statement and is read as one. A
				// marker that is not the page's is not, and this is the line that
				// keeps the new shape from being "any fourth cell at all" — the
				// widening nobody could see the edge of.
				'a package cell carrying a marker the page does not use',
				`| Gappy Newcomer | gappy-newcomer | \`${ZEN_HOST}/chat/completions\` | n/a |`,
			],
			[
				// The dropped COLUMN, which is the same class as the empty cell
				// above and was still passing: three cells carrying one code span.
				// The shape test read that as prose, so the model left the roster
				// with no message and the run still reported agreement.
				'a package column that is gone rather than empty',
				`| Phi Newcomer | phi-newcomer | \`${ZEN_HOST}/chat/completions\` |`,
			],
			[
				// Five cells rather than four, with the extra one in the middle.
				// The name cell of the wireless pattern is `[^|]+?` precisely so
				// it cannot swallow this pipe; written as the route pattern's
				// `.+?` it reads as a wireless route NAMED "Notes | extra", which
				// is a mis-read row rather than a stopped run.
				'a fifth cell sitting in the middle of the row',
				`| Notes | extra | omega | \`${ZEN_HOST}/systemone\` | - |`,
			],
		]
		for (const [why, row] of rows) {
			assert.equal(isRouteRowShaped(row), true, `the shape test must flag ${why}`)
			assert.throws(() => zenPage(`${ZEN_PAGE}\n${row}\n`), /did not read as one/, why)
		}
	})

	/**
	 * What keeps the widened shape test off everything else: it counts cells AND
	 * a code span, and a table's separator row is three or more cells with no
	 * code span at all. Both live pages carry two of them per table, so a rule
	 * written as "three or more cells" alone would stop every run.
	 */
	test('does not read a table separator or an unquoted row as a route row', () => {
		assert.equal(isRouteRowShaped('| --- | --- | --- | --- |'), false)
		assert.equal(isRouteRowShaped('| Alpha Chat | a plain row | with no code span |'), false)
		// And a page carrying one still parses to the same routes.
		const page = `${ZEN_PAGE}\n| --- | --- | --- | --- |\n`
		assert.equal(zenPage(page).routes.length, 5)
	})

	/** The live Go page has exactly one such row, and it is prose. */
	test('does not mistake a prose row carrying a code span for a route row', () => {
		const page = `${ZEN_PAGE}\n| **Thing** | Go recognizes a native header. Our [request for \`a header\`](https://example.test/1) explains. |\n`
		assert.equal(zenPage(page).routes.length, 5)
	})
})

describe('derive reports what it will not carry', () => {
	/**
	 * A route row may state its endpoint and no package, with the dash the pages
	 * give a cell that has no value. That is a row the page publishes rather than
	 * one this script lost, so it is read — and it is then a DECISION rather than
	 * a source failure, because the page has stated the model and the wire is the
	 * half no source states.
	 *
	 * What this pins is both halves at once, and honestly: the row arrives with
	 * its name, its id and its endpoint, and it is reported with the unstated
	 * package as its reason even though models.dev holds a complete entry for it.
	 * The entry is deliberately complete — the point is that no answer there
	 * could make the row carryable, so a run that reported this model as anything
	 * other than a missing wire would be reporting a reason it does not have.
	 *
	 * What it does not pin: the service's own answer. A live id that no page
	 * documents is a different absence and is covered beside this.
	 */
	test('reads a route row that states no wire, and reports it as a decision', () => {
		const page = `${ZEN_PAGE_DECIDED}\n${wirelessRow(ZEN_HOST, 'Omega Wireless', 'omega-wireless', '/systemone')}\n`
		const read = zenPage(page).routes
		const row = read[read.length - 1]
		assert.equal(row?.id, 'omega-wireless')
		assert.equal(row?.endpoint, `${ZEN_HOST}/systemone`)
		assert.equal(row?.npm, undefined)

		const dev = structuredClone(MODELS_DEV)
		dev.opencode.models['omega-wireless'] = {
			limit: { context: 64000, output: 8192 },
			modalities: { input: ['text'] },
			tool_call: true,
		}
		const { models, undecided } = derive('zen', zenPage(page), 'opencode', dev.opencode, {}, ZEN_SERVED)
		assert.equal(
			models.some((m: { id: string }) => m.id === 'omega-wireless'),
			false,
		)
		assert.deepEqual(undecided, [
			['zen/omega-wireless', 'the page states no AI SDK package for it, so no wire is known'],
		])
	})

	test('names a price row the route table does not', () => {
		const page = `${ZEN_PAGE}\n| Ghost Model | $1.00 | $2.00 | $0.00 |\n`
		const { orphanPrices } = derive('zen', zenPage(page), 'opencode', MODELS_DEV.opencode, {}, ZEN_SERVED)
		assert.deepEqual(orphanPrices, ['Ghost Model'])
	})

	/**
	 * A missing entry is a curation decision. An entry that is there and has
	 * lost its fields is models.dev having changed shape, and every model
	 * reporting it at once is exactly what a renamed field looks like — so it
	 * stops the run instead of asking a person to decide something that is not
	 * theirs to decide.
	 */
	test('refuses an entry that exists but has lost its fields', () => {
		const dev = structuredClone(MODELS_DEV)
		dev.opencode.models['alpha-chat'] = {
			limits: { context: 1, output: 1 },
			modalities: { input: ['text'] },
			tool_call: true,
		}
		assert.throws(
			() => derive('zen', zenPage(ZEN_PAGE_DECIDED), 'opencode', dev.opencode, {}, ZEN_SERVED),
			/missing the fields/,
		)
	})

	/**
	 * The field whose loss is not self-announcing. Every other missing field
	 * leaves the model `incomplete` and is reported; a missing `tool_call` reads
	 * as "this model takes no tools", so a rename would rewrite every entry to
	 * `supportsToolUse: false`, print a drift report reading "run the
	 * generator", and go green once somebody did — a source that moved, offered
	 * as a decision, with the wrong answer available.
	 */
	test('refuses a models.dev that has lost tool_call from every entry', () => {
		const dev = structuredClone(MODELS_DEV)
		for (const entry of Object.values(dev.opencode.models) as Record<string, unknown>[]) {
			entry.toolCall = entry.tool_call
			delete entry.tool_call
		}
		assert.throws(
			() => derive('zen', zenPage(ZEN_PAGE_DECIDED), 'opencode', dev.opencode, {}, ZEN_SERVED),
			/tool_call/,
		)
	})

	/** One entry of many is a real answer, and is carried as false. */
	test('carries a model whose entry alone has no tool_call', () => {
		const dev = structuredClone(MODELS_DEV)
		delete (dev.opencode.models['gamma-free'] as Record<string, unknown>).tool_call
		const { models } = derive(
			'zen',
			zenPage(ZEN_PAGE_DECIDED),
			'opencode',
			dev.opencode,
			{},
			ZEN_SERVED,
		)
		assert.equal(models.find((m: { id: string }) => m.id === 'gamma-free')?.supportsToolUse, false)
	})
})

describe('checkRosterFloor', () => {
	const roster = (size: number) => Array.from({ length: size }, () => ({ id: 'x' }))

	test('refuses an empty roster', () => {
		assert.throws(
			() => checkRosterFloor({ zen: [], go: roster(1) }, { zen: roster(1), go: roster(1) }),
			/came out empty/,
		)
	})

	test('refuses a collapse past the floor', () => {
		assert.throws(
			() => checkRosterFloor({ zen: roster(5), go: roster(28) }, { zen: roster(60), go: roster(28) }),
			/past the floor/,
		)
	})

	/** A removal somebody chose is not a collapse, and must still be possible. */
	test('allows a removal that is curation rather than collapse', () => {
		assert.doesNotThrow(() =>
			checkRosterFloor({ zen: roster(60), go: roster(27) }, { zen: roster(60), go: roster(28) }),
		)
	})
})

describe('the read-back report', () => {
	const carried = {
		id: 'alpha-chat',
		name: 'Alpha Chat',
		protocol: 'chat',
		contextWindow: 200000,
		maxOutputTokens: 64000,
		inputModalities: ['text', 'image'],
		inputPrice: 1.5,
		outputPrice: 6,
		supportsToolUse: true,
		effortLevels: ['low', 'high'],
		supportsAnonymousAccess: false,
	}

	test('reads back what the renderer wrote', () => {
		const text = render({ zen: [carried], go: [] }, '2026-01-01')
		assert.deepEqual(parseRendered(text).zen, [carried])
	})

	test('names a changed field', () => {
		const after = { zen: [{ ...carried, inputPrice: 99 }], go: [] }
		assert.deepEqual(describeChanges({ zen: [carried], go: [] }, after), [
			'zen changed: alpha-chat (inputPrice)',
		])
	})

	test('names a removal rather than letting it pass', () => {
		assert.deepEqual(describeChanges({ zen: [carried], go: [] }, { zen: [], go: [] }), [
			'zen REMOVED: alpha-chat',
		])
	})
})

describe('renderEntry', () => {
	const base: RenderedModel = {
		id: 'alpha-chat',
		name: 'Alpha Chat',
		protocol: 'chat',
		contextWindow: 200000,
		maxOutputTokens: 64000,
		inputModalities: ['text', 'image'],
		inputPrice: 10,
		outputPrice: 0,
		supportsToolUse: true,
		effortLevels: [],
		supportsAnonymousAccess: false,
	}

	test('writes a whole price with a decimal point and a zero plainly', () => {
		const text = renderEntry(base)
		assert.match(text, /inputPrice: 10\.0,/)
		assert.match(text, /outputPrice: 0,/)
	})

	test('writes a fractional price as itself', () => {
		assert.match(renderEntry({ ...base, inputPrice: 0.435 }), /inputPrice: 0\.435,/)
	})

	test('states anonymous access only for a model that has it', () => {
		assert.equal(renderEntry(base).includes('supportsAnonymousAccess'), false)
		assert.match(
			renderEntry({ ...base, supportsAnonymousAccess: true }),
			/\n\t\tsupportsAnonymousAccess: true,/,
		)
	})
})

describe('the gate, end to end', () => {
	test('reports drift against a module its sources no longer derive', () => {
		// The fixture's own render, repriced by hand — a catalogue that is behind
		// upstream by one field.
		const behind = baselineFor(ZEN_PAGE_DECIDED, MODELS_DEV, {}).replace(
			'inputPrice: 1.5,',
			'inputPrice: 99,',
		)
		const result = run(['--check', '--from', fixtureDir(ZEN_PAGE_DECIDED, MODELS_DEV, {}, behind)])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /ZEN CATALOGUE DRIFT/)
		// The report names the field, not only that something differs.
		assert.match(result.stderr, /zen changed: alpha-chat \(inputPrice\)/)
		assert.match(result.stderr, /never edit models\.ts/i)
	})

	/**
	 * The agreement path, offline and hermetic. `--from` replaces the module
	 * under test as well as the sources, so this is the same comparison CI
	 * makes — minus the fetch. The suite still never needs the network; the
	 * gate step runs the networked `--check` beside this file rather than
	 * inside it.
	 */
	test('agrees when the module is what its own sources derive', () => {
		const result = run(['--check', '--from', fixtureDir(ZEN_PAGE_DECIDED)])
		assert.equal(result.status, 0)
		assert.match(result.stdout, /matches its source/)
	})

	test('reports a route row it could not read as a source, not as drift', () => {
		const page = `${ZEN_PAGE_DECIDED}\n${routeRow(ZEN_HOST, 'Wandering Model', 'wandering_model', '/chat/completions', CHAT)}\n`
		const result = run(['--check', '--from', fixtureDir(page)])
		assert.equal(result.status, 2)
		assert.match(result.stderr, /did not read as one/)
	})

	test('reports a price row no route row names', () => {
		const page = `${ZEN_PAGE_DECIDED}\n| Ghost Model | $1.00 | $2.00 | $0.00 |\n`
		const result = run(['--check', '--from', fixtureDir(page)])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /price rows name a model their own page does not route/)
		assert.match(result.stderr, /Ghost Model/)
	})

	/** A module that collapsed is not a decision anybody can make. */
	test('reports a collapsed models.dev as a source, not as a decision', () => {
		const modelsDev = structuredClone(MODELS_DEV)
		for (const entry of Object.values(modelsDev.opencode.models)) {
			entry.limit = undefined
		}
		const result = run(['--check', '--from', fixtureDir(ZEN_PAGE_DECIDED, modelsDev)])
		assert.equal(result.status, 2)
		assert.match(result.stderr, /SOURCE UNUSABLE/)
		assert.match(result.stderr, /missing the fields/)
	})

	/**
	 * Exit 2 is the other failure, and the distinction is the point: a source
	 * that moved is not a decision anybody can make by editing the catalogue.
	 */
	test('reports an unusable source as exit 2, not as drift', () => {
		const result = run(['--check', '--from', fixtureDir('# Zen\n\nNothing here.\n')])
		assert.equal(result.status, 2)
		assert.match(result.stderr, /SOURCE UNUSABLE/)
		assert.match(result.stderr, /no route table/)
	})

	test('reports a documented model that is neither carried nor omitted', () => {
		const result = run(['--check', '--from', fixtureDir()])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /NEEDS A DECISION/)
		assert.match(result.stderr, /zen\/delta-undocumented/)
	})

	/**
	 * The dropped column, end to end, and the case the previous round missed: a
	 * route row that kept its values and lost its package cell used to leave the
	 * roster with no message at all while the run printed the agreement line.
	 */
	test('reports a route row that lost its package column as a source', () => {
		const page = `${ZEN_PAGE_DECIDED}\n| Phi Newcomer | phi-newcomer | \`${ZEN_HOST}/chat/completions\` |\n`
		const result = run(['--check', '--from', fixtureDir(page)])
		assert.equal(result.status, 2)
		assert.match(result.stderr, /SOURCE UNUSABLE/)
		assert.match(result.stderr, /did not read as one/)
		assert.match(result.stderr, /Phi Newcomer/)
	})

	/** The renamed field whose loss would otherwise be carried as "no tools". */
	test('reports a models.dev that lost tool_call as a source, not as drift', () => {
		const modelsDev = structuredClone(MODELS_DEV)
		for (const entry of Object.values(modelsDev.opencode.models) as Record<string, unknown>[]) {
			entry.toolCall = entry.tool_call
			delete entry.tool_call
		}
		const result = run(['--check', '--from', fixtureDir(ZEN_PAGE_DECIDED, modelsDev)])
		assert.equal(result.status, 2)
		assert.match(result.stderr, /SOURCE UNUSABLE/)
		assert.match(result.stderr, /tool_call/)
	})

	/**
	 * The third dimension. An id the service serves and no page documents has no
	 * derivable wire, so it cannot be carried — but the driver dropping it in
	 * silence is exactly the defect this whole change is for, so it is exit 1
	 * and it is named.
	 */
	test('reports an id the service serves and the catalogue neither carries nor omits', () => {
		const result = run([
			'--check',
			'--from',
			fixtureDir(ZEN_PAGE_DECIDED, MODELS_DEV, {}, undefined, {
				zen: [...DECIDED_SERVED, 'gpt-6-unlisted'],
			}),
		])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /served by the service and are neither carried nor omitted/)
		assert.match(result.stderr, /zen\/gpt-6-unlisted/)
	})

	/**
	 * And the same roster with that decision recorded is agreement — which also
	 * pins the other half of the rule: an omission for an id the service still
	 * serves is not stale, however undocumented it is.
	 */
	test('agrees once the served id is omitted, and does not call that omission stale', () => {
		const omissions = {
			'zen/gpt-6-unlisted': 'Served, documented on no page, so no wire is derivable.',
		}
		const result = run([
			'--check',
			'--from',
			fixtureDir(ZEN_PAGE_DECIDED, MODELS_DEV, omissions, undefined, {
				zen: [...DECIDED_SERVED, 'gpt-6-unlisted'],
			}),
		])
		assert.equal(result.status, 0)
		assert.match(result.stdout, /matches its source/)
		assert.doesNotMatch(result.stderr, /no longer apply/)
	})

	/**
	 * The served roster is the one source the fixture cannot ship a file for
	 * when the point is the FETCH, so it has an environment seam of its own —
	 * `NAMZU_ZEN_MODELS_BASE`, the same shape as `NAMZU_ZEN_DOCS_REF` for the
	 * pages. This drives it against a server in this process, which is why the
	 * runner is asynchronous: a synchronous spawn would block the loop that has
	 * to answer the request.
	 *
	 * What it proves is the distinction the exit codes have to keep: an answer
	 * is a roster, and an id in it that nothing curates is a decision (1); no
	 * answer at all is a source that could not be read (2), never an agreement
	 * over a check that quietly did not happen.
	 */
	test('reads the served roster over HTTP, and refuses to pass when the service does not answer', async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify(catalogue([...DECIDED_SERVED, 'gpt-6-unlisted'])))
		})
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
		const address = server.address()
		assert.ok(address !== null && typeof address === 'object')
		try {
			const dir = fixtureWithoutServedRoster()
			const answered = await runAsync(['--check', '--from', dir], {
				NAMZU_ZEN_MODELS_BASE: `http://127.0.0.1:${address.port}`,
			})
			assert.equal(answered.status, 1)
			assert.match(answered.stderr, /zen\/gpt-6-unlisted/)

			// Nothing is listening on this port, so the fetch cannot be read. The
			// gate must not report agreement over a roster it never saw.
			const refused = await runAsync(['--check', '--from', dir], {
				NAMZU_ZEN_MODELS_BASE: 'http://127.0.0.1:1',
			})
			assert.equal(refused.status, 2)
			assert.match(refused.stderr, /SOURCE UNUSABLE/)
		} finally {
			server.close()
		}
	})

	/**
	 * A refresh that found nothing new writes nothing, which is what lets a
	 * scheduled run open a pull request only when there is something to review.
	 * `Refreshed` names the day the roster last moved, so an unchanged roster
	 * keeps the date it has instead of restamping today.
	 *
	 * The agreement is asserted with `--check` FIRST, on purpose: without it the
	 * script writes to the tree's own module, and this test must never be the one
	 * that finds out the fixture had drifted.
	 */
	test('a refresh with nothing to change leaves the module alone', () => {
		const dir = fixtureDir(ZEN_PAGE_DECIDED)
		const module = join(dir, 'models.ts')
		assert.equal(run(['--check', '--from', dir]).status, 0)
		const before = readFileSync(module, 'utf8')
		const result = run(['--from', dir])
		assert.equal(result.status, 0)
		assert.match(result.stdout, /matches its source/)
		assert.equal(readFileSync(module, 'utf8'), before)
	})

	/**
	 * The other half of that rule, and the one the scheduled workflow reads: the
	 * module is what its sources derive and the run still exits 1, because the
	 * service serves an id nobody has curated. Nothing about the roster is
	 * written wrongly — there is simply a decision outstanding.
	 */
	test('a refresh exits 1 on a served id it cannot curate, though the module is right', () => {
		const dir = fixtureDir(ZEN_PAGE_DECIDED, MODELS_DEV, {}, undefined, {
			zen: [...DECIDED_SERVED, 'gpt-6-unlisted'],
		})
		const checked = run(['--check', '--from', dir])
		assert.equal(checked.status, 1)
		// Exit 1 from the served roster and NOT from drift: the refresh below
		// writes to the tree's own module when the module disagrees, and this test
		// must not be the one that finds out the fixture had drifted.
		assert.doesNotMatch(checked.stderr, /ZEN CATALOGUE DRIFT/)
		const result = run(['--from', dir])
		assert.equal(result.status, 1)
		assert.match(result.stderr, /served by the service and are neither carried nor omitted/)
		assert.match(result.stderr, /zen\/gpt-6-unlisted/)
	})
})

/**
 * The formatter is part of the run, and it is a tool the tree has to carry.
 *
 * `biomeEntryPoint()` throws an `UnusableSourceError` like any other missing
 * source, and it used to do it outside every catch: a tree without
 * `node_modules` printed a raw stack from `main().catch` and exited 1, which is
 * the code that means "a person can decide this". Nobody installs their way out
 * of a missing binary, so this is the 2 the file's contract promises.
 *
 * Reproduced in a COPY of the tree with no `node_modules` anywhere, because the
 * only way to test a missing dependency is not to have it — and the worktree
 * this runs in keeps its own.
 */
describe('a tree without its formatter', () => {
	test('reports a missing biome as a source failure, not as drift', () => {
		const dir = tempDir()
		mkdirSync(join(dir, 'scripts'), { recursive: true })
		copyFileSync(SCRIPT, join(dir, 'scripts', 'generate-zen-models.mjs'))
		const copy = join(dir, 'scripts', 'generate-zen-models.mjs')
		const result = spawnSync(process.execPath, [copy, '--check', '--from', fixtureDir(ZEN_PAGE_DECIDED)], {
			cwd: dir,
			encoding: 'utf8',
		})
		assert.equal(result.status, 2)
		assert.match(result.stderr, /SOURCE UNUSABLE/)
		assert.match(result.stderr, /Could not find the biome CLI/)
		// Not the raw stack a rejection at the top used to print.
		assert.doesNotMatch(result.stderr, /at Object\.<anonymous>/)
	})
})
