/**
 * A request reached the configured MCP server, but no response from the
 * requested operation was received because that server redirected it.
 *
 * This stays an internal transport-to-adapter signal. The public tool result
 * carries the stable, serializable outcome fields instead of exposing an
 * Error subclass as API.
 */
export class MCPHttpRedirectError extends Error {
	readonly code = 'mcp_http_redirect_refused'
	readonly remoteOutcomeUnknown: boolean

	constructor(
		readonly status: number,
		readonly requestMethod?: string,
	) {
		const base = `MCP HTTP ${status} redirect was not followed because authenticated requests must remain at their configured endpoint. Configure the final MCP endpoint directly.`
		const outcome =
			requestMethod === 'tools/call'
				? ' The configured MCP server received the tool call, so the remote outcome is unknown; do not automatically retry.'
				: ''
		super(base + outcome)
		this.name = 'MCPHttpRedirectError'
		this.remoteOutcomeUnknown = requestMethod === 'tools/call'
	}
}

export function refuseMcpHttpRedirect(response: Response, requestMethod?: string): void {
	if (response.status >= 300 && response.status < 400) {
		throw new MCPHttpRedirectError(response.status, requestMethod)
	}
}
