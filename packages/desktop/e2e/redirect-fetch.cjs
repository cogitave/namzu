// Loaded by cli-entry.mjs before the real CLI. Sends the chat-completions
// driver's requests to the scripted local model server and refuses any other
// non-loopback host. Test-only: nothing in the product reads NAMZU_E2E_MODEL_URL.
const target = process.env.NAMZU_E2E_MODEL_URL;
if (target) {
	const real = globalThis.fetch;
	globalThis.fetch = (input, init) => {
		const raw =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		const url = new URL(raw);
		if (url.hostname === "api.openai.com") {
			const next = new URL(target);
			next.pathname = url.pathname;
			next.search = url.search;
			return real(
				input instanceof Request ? new Request(next, input) : next,
				init,
			);
		}
		if (url.hostname === "127.0.0.1" || url.hostname === "localhost")
			return real(input, init);
		return Promise.reject(
			new Error(`e2e: outbound request blocked: ${url.host}`),
		);
	};
}
