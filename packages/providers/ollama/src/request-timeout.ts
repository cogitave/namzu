/**
 * Give a request a deadline the caller asked for.
 *
 * `OllamaConfig.timeout` was declared with no doc comment and read by
 * nothing: the constructor forwarded `host` and `fetch` and never looked at
 * it, so a host that set a timeout got none. The failure it exists for is
 * specific and common with a local server — the process is up, the socket
 * accepts, and the model never answers because it is still loading or the
 * machine is out of memory. With no deadline the run waits forever and the
 * only recourse is killing it.
 *
 * The deadline covers the WHOLE request, not the time to the first byte. A
 * chat request here is a streaming one, so bounding only the head would
 * leave the failure this exists for — a server that accepts and then never
 * finishes — unbounded. A host that wants long generations sets a long
 * timeout or none at all; leaving it absent keeps the previous behaviour
 * exactly.
 */
export function withRequestTimeout(
	base: typeof fetch | undefined,
	timeoutMs: number | undefined,
): typeof fetch | undefined {
	if (timeoutMs === undefined) return base
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		throw new Error(
			`Ollama timeout must be a positive number of milliseconds, got ${timeoutMs}. A zero or negative deadline would abort every request before it was sent.`,
		)
	}

	const inner = base ?? fetch

	return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const deadline = AbortSignal.timeout(timeoutMs)
		// Composed, never replaced. The caller's signal is how a run cancels
		// mid-stream, and dropping it for the deadline would leave a local
		// model generating after the run that asked for it has stopped.
		const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline
		return inner(input, { ...init, signal })
	}
}
