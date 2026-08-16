import { z } from 'zod'

import { WebFetchRefusedError } from '../../connector/web/types.js'
import { defineTool } from '../defineTool.js'

/**
 * The two web tools, and the reason they are one file.
 *
 * Both declare `category: 'network'`, which is not decoration: the
 * authorization presets route `network` to human review and only the
 * `unattended` preset — the one that requires the sandbox to enforce
 * network isolation — auto-approves it. Getting that category wrong would
 * quietly hand every sandboxed run outbound reach, so the two tools that
 * most need it are written where the reason is visible once.
 *
 * `web_search` was already a name in this tree before either tool existed:
 * two fixtures invented it, one to have a deferred-loading tool in a
 * catalog test and one to have a network tool for a gate test. Neither was
 * wrong, and both were describing a tool nobody had written — so the name
 * had a meaning in the tests and none in the runtime.
 */

const fetchInput = z.object({
	url: z.string().min(1).describe('The absolute http(s) URL to fetch.'),
})

const searchInput = z.object({
	query: z.string().min(1).describe('What to search for.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(25)
		.optional()
		.describe('How many results to return. The provider may return fewer.'),
})

export const WEB_FETCH_TOOL_NAME = 'web_fetch'
export const WEB_SEARCH_TOOL_NAME = 'web_search'

export const WebFetchTool = defineTool({
	name: WEB_FETCH_TOOL_NAME,
	description:
		'Fetches an http(s) URL and returns its body as text. Requests to addresses inside the host, and non-web schemes, are refused.',
	inputSchema: fetchInput,
	// The load-bearing line. `network` is what the presets branch on, and a
	// tool that claimed `analysis` would auto-approve under every sandboxed
	// preset — handing outbound reach to runs whose sandbox was never asked
	// to confine the network.
	category: 'network',
	permissions: ['network_access'],
	// Reads a page and changes nothing HERE. That is not the same as
	// harmless — a GET can still act on a remote system — which is why the
	// category, not this flag, is what the presets use.
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		if (!context.web?.fetch) {
			return {
				success: false,
				output: '',
				error: 'This run has no web fetch provider configured, so no URL can be fetched.',
			}
		}

		try {
			const result = await context.web.fetch.fetch({
				url: input.url,
				...(context.abortSignal ? { signal: context.abortSignal } : {}),
			})

			// The chain, when there was one. A model citing the URL it asked
			// for after three redirects is citing a page it did not read.
			const arrivedAt = result.redirects.length > 1 ? `\n[redirected to ${result.url}]` : ''
			const cut = result.truncated
				? '\n[the page was longer than the fetch limit and was cut here]'
				: ''

			return {
				success: true,
				output: `${result.body}${arrivedAt}${cut}`,
				data: {
					url: result.url,
					status: result.status,
					truncated: result.truncated,
					redirects: result.redirects,
					...(result.contentType === undefined ? {} : { contentType: result.contentType }),
				},
			}
		} catch (err) {
			if (err instanceof WebFetchRefusedError) {
				// The refusal reaches the model in its own words, because the
				// reason is actionable: a wrong scheme is a mistake it can fix,
				// and a private address is one it should stop trying.
				return { success: false, output: '', error: err.message }
			}
			return {
				success: false,
				output: '',
				error: `Fetching "${input.url}" failed: ${err instanceof Error ? err.message : String(err)}`,
			}
		}
	},
})

export const WebSearchTool = defineTool({
	name: WEB_SEARCH_TOOL_NAME,
	description:
		"Searches the web and returns titles, URLs and the provider's own snippets. Fetch a result with web_fetch before relying on its contents.",
	inputSchema: searchInput,
	category: 'network',
	permissions: ['network_access'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	async execute(input, context) {
		if (!context.web?.search) {
			// This kernel ships no search backend, so "not configured" is the
			// ordinary case rather than an error state — and saying which
			// piece is missing is what tells an operator it is a wiring
			// decision and not a failure.
			return {
				success: false,
				output: '',
				error:
					'This run has no web search provider configured. Namzu ships no search backend; a host supplies one.',
			}
		}

		const result = await context.web.search.search({
			query: input.query,
			...(input.limit === undefined ? {} : { limit: input.limit }),
			...(context.abortSignal ? { signal: context.abortSignal } : {}),
		})

		if (result.hits.length === 0) {
			// A real answer, and distinct from the refusal above: the search
			// happened and found nothing.
			return { success: true, output: `No results for "${input.query}".`, data: { hits: [] } }
		}

		return {
			success: true,
			output: result.hits
				.map(
					(hit, i) =>
						`${i + 1}. ${hit.title}\n   ${hit.url}${hit.snippet ? `\n   ${hit.snippet}` : ''}`,
				)
				.join('\n'),
			data: { query: result.query, hits: result.hits },
		}
	},
})
