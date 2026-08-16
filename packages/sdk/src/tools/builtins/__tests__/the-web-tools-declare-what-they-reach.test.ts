import { describe, expect, it } from 'vitest'

import { AuthorizationGate } from '../../../authorization/gate.js'
import {
	SANDBOXED_PRESET,
	SANDBOXED_SHELL_PRESET,
	SUPERVISED_PRESET,
	UNATTENDED_PRESET,
} from '../../../authorization/permission-presets.js'
import { WebFetchRefusedError } from '../../../connector/web/types.js'
import type { RunId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { NOOP_LOGGER } from '../../../utils/log/create-logger.js'
import { WEB_FETCH_TOOL_NAME, WEB_SEARCH_TOOL_NAME, WebFetchTool, WebSearchTool } from '../web.js'

/**
 * The web tools, and the one line that decides who may use them.
 *
 * `category: 'network'` is what the authorization presets branch on. A tool
 * that claimed `analysis` would auto-approve under every sandboxed preset,
 * handing outbound reach to runs whose sandbox was never asked to confine
 * the network — so the category is tested against the real gate rather than
 * asserted as a property of an object.
 *
 * `web_search` was a name in this tree before either tool existed: two
 * fixtures invented it, one for a deferred-loading catalog test and one for
 * a network gate test. Both were describing a tool nobody had written.
 */

const context = (over: Partial<ToolContext> = {}): ToolContext => ({
	runId: 'run_web' as RunId,
	workingDirectory: '/tmp',
	abortSignal: new AbortController().signal,
	env: {},
	log: () => {},
	...over,
})

const page = (over: Record<string, unknown> = {}) => ({
	url: 'https://example.com/',
	status: 200,
	body: 'the page',
	truncated: false,
	redirects: ['https://example.com/'],
	...over,
})

describe('the category is what the presets read', () => {
	it('sends both tools to review under every sandboxed preset', () => {
		// The sandboxed presets deliberately do not require network isolation,
		// so they must not auto-approve a network tool — their own docstrings
		// say network calls go to a human.
		for (const preset of [SANDBOXED_PRESET, SANDBOXED_SHELL_PRESET, SUPERVISED_PRESET]) {
			const gate = new AuthorizationGate(preset.gate, NOOP_LOGGER)
			for (const tool of [WebFetchTool, WebSearchTool]) {
				expect(
					gate.evaluate({ toolName: tool.name, toolInput: { url: 'x', query: 'x' }, toolDef: tool })
						.decision,
				).toBe('review')
			}
		}
	})

	it('auto-approves only under the preset that requires network isolation', () => {
		// `unattended` is the one that pays for it: it requires the sandbox to
		// enforce `network`, and that requirement is why it may spend it.
		const gate = new AuthorizationGate(UNATTENDED_PRESET.gate, NOOP_LOGGER)

		for (const tool of [WebFetchTool, WebSearchTool]) {
			expect(
				gate.evaluate({ toolName: tool.name, toolInput: { url: 'x', query: 'x' }, toolDef: tool })
					.decision,
			).toBe('allow')
		}
	})

	it('declares network access as a permission too', () => {
		for (const tool of [WebFetchTool, WebSearchTool]) {
			expect(tool.category).toBe('network')
			expect(tool.permissions).toContain('network_access')
		}
	})

	it('uses the names the fixtures already invented', () => {
		// Two tests named `web_search` before it existed. Reconciled rather
		// than renamed: the fixtures were describing this tool.
		expect(WEB_SEARCH_TOOL_NAME).toBe('web_search')
		expect(WEB_FETCH_TOOL_NAME).toBe('web_fetch')
	})
})

describe('web_fetch', () => {
	it('returns the body', async () => {
		const result = await WebFetchTool.execute(
			{ url: 'https://example.com/' },
			context({ web: { fetch: { fetch: async () => page() } } }),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('the page')
	})

	it('says where it actually arrived after a redirect', async () => {
		// A model citing the URL it asked for after three redirects is citing
		// a page it did not read.
		const result = await WebFetchTool.execute(
			{ url: 'https://example.com/' },
			context({
				web: {
					fetch: {
						async fetch() {
							return page({
								url: 'https://elsewhere.example/final',
								redirects: ['https://example.com/', 'https://elsewhere.example/final'],
							})
						},
					},
				},
			}),
		)

		expect(result.output).toContain('redirected to https://elsewhere.example/final')
	})

	it('says nothing about redirects when there were none', async () => {
		const result = await WebFetchTool.execute(
			{ url: 'https://example.com/' },
			context({ web: { fetch: { fetch: async () => page() } } }),
		)

		expect(result.output).not.toContain('redirected')
	})

	it('marks a truncated page as truncated', async () => {
		// A cut page reading as whole is a model concluding something from a
		// document whose second half it never saw.
		const result = await WebFetchTool.execute(
			{ url: 'https://example.com/' },
			context({ web: { fetch: { fetch: async () => page({ truncated: true }) } } }),
		)

		expect(result.output).toContain('cut here')
		expect((result.data as { truncated: boolean }).truncated).toBe(true)
	})

	it('passes a refusal through in the guard’s own words', async () => {
		// The reason is actionable: a wrong scheme is a mistake the model can
		// fix, and a private address is one it should stop trying.
		const result = await WebFetchTool.execute(
			{ url: 'http://127.0.0.1/' },
			context({
				web: {
					fetch: {
						async fetch() {
							throw new WebFetchRefusedError('Refused "127.0.0.1" — inside this host.', {
								url: 'http://127.0.0.1/',
								reason: 'private-address',
							})
						},
					},
				},
			}),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('inside this host')
	})

	it('reports an ordinary transport failure with the URL', async () => {
		const result = await WebFetchTool.execute(
			{ url: 'https://example.com/' },
			context({
				web: {
					fetch: {
						async fetch() {
							throw new Error('ECONNRESET')
						},
					},
				},
			}),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('https://example.com/')
		expect(result.error).toContain('ECONNRESET')
	})

	it('says so when no provider is configured', async () => {
		const result = await WebFetchTool.execute({ url: 'https://example.com/' }, context())

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/no web fetch provider/i)
	})
})

describe('web_search', () => {
	it('lists what the provider returned', async () => {
		const result = await WebSearchTool.execute(
			{ query: 'ledgers' },
			context({
				web: {
					search: {
						async search() {
							return {
								query: 'ledgers',
								hits: [{ title: 'A Page', url: 'https://a.example', snippet: 'about ledgers' }],
							}
						},
					},
				},
			}),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('A Page')
		expect(result.output).toContain('https://a.example')
		expect(result.output).toContain('about ledgers')
	})

	it('carries a hit with no snippet without inventing one', async () => {
		// A snippet this kernel wrote would be a claim about a page nobody
		// fetched, and a model citing it would be citing us.
		const result = await WebSearchTool.execute(
			{ query: 'ledgers' },
			context({
				web: {
					search: {
						async search() {
							return { query: 'ledgers', hits: [{ title: 'A Page', url: 'https://a.example' }] }
						},
					},
				},
			}),
		)

		expect(result.output).toContain('A Page')
		expect(result.output.split('\n')).toHaveLength(2)
	})

	it('distinguishes "found nothing" from "no provider"', async () => {
		// The first is a search that happened; the second is a wiring
		// decision. Reporting them the same way tells an operator nothing.
		const found = await WebSearchTool.execute(
			{ query: 'x' },
			context({
				web: {
					search: {
						async search() {
							return { query: 'x', hits: [] }
						},
					},
				},
			}),
		)
		const unwired = await WebSearchTool.execute({ query: 'x' }, context())

		expect(found.success).toBe(true)
		expect(found.output).toMatch(/No results/)
		expect(unwired.success).toBe(false)
		expect(unwired.error).toMatch(/ships no search backend/)
	})

	it('forwards the limit the model asked for', async () => {
		let seen: number | undefined
		await WebSearchTool.execute(
			{ query: 'x', limit: 3 },
			context({
				web: {
					search: {
						async search(request) {
							seen = request.limit
							return { query: 'x', hits: [] }
						},
					},
				},
			}),
		)

		expect(seen).toBe(3)
	})
})

describe('a refusal reaches the model in the guard’s own words', () => {
	it('does not repackage it as a generic transport failure', async () => {
		// The two failures need different next moves: a wrong scheme is a
		// mistake the model can fix, a private address is one it should stop
		// trying, and a connection reset is worth retrying. Flattening them
		// into one sentence tells it none of that.
		const refused = await WebFetchTool.execute(
			{ url: 'file:///etc/passwd' },
			context({
				web: {
					fetch: {
						async fetch() {
							throw new WebFetchRefusedError('Refused "file:" — only http and https are fetched.', {
								url: 'file:///etc/passwd',
								reason: 'scheme',
							})
						},
					},
				},
			}),
		)

		expect(refused.error).toBe('Refused "file:" — only http and https are fetched.')
		// Specifically NOT wrapped: the generic branch prefixes with
		// `Fetching "<url>" failed:`, which buries the reason behind the URL.
		expect(refused.error).not.toContain('Fetching')
	})
})
