/**
 * A fake `fetch` for a test that drives a real driver over the wire.
 *
 * The DeepSeek driver asks the vendor's models endpoint for the context window
 * before a turn, then falls back to its documented limits. A scripted chat
 * sequence has no business consuming that request, so it is answered here with
 * an empty listing and never reaches the wrapped function.
 */
export function answerModelsListing(inner: typeof fetch): typeof fetch {
	return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
		const method = (
			init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
		).toUpperCase()
		if (method === 'GET' && /\/models(\?|$)/.test(url)) {
			return new Response(JSON.stringify({ object: 'list', data: [] }), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		}
		return inner(input, init)
	}) as typeof fetch
}
