// The headers a scripted provider failure is answered with, shared by both scripted servers.
//
// The host retries a rate limit, a timeout or a server fault ten times before it stops the turn,
// and a Retry-After over a minute is not waited for: the turn stops at once and offers Retry.
// A scripted failure that sets no wait of its own therefore asks for a long one, so the window
// shows the stopped turn and not the countdown. A flow that wants the countdown sets its own header.
export function failureHeaders(step) {
	const headers = step.headers ?? {};
	const retried =
		step.status === 408 || step.status === 409 || step.status === 429 || step.status >= 500;
	const waits = Object.keys(headers).some((name) => name.toLowerCase() === "retry-after");
	return { ...(retried && !waits ? { "retry-after": "61" } : {}), ...headers };
}
