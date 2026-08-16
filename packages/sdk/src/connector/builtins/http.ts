import { z } from 'zod'
import type {
	AuthConfig,
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
	HttpConnectorConfig,
	HttpRequestInput,
	HttpResponseOutput,
} from '../../types/connector/index.js'
import { BaseConnector } from '../BaseConnector.js'

const HttpConnectorConfigSchema = z.object({
	baseUrl: z.string().url(),
	defaultHeaders: z.record(z.string()).optional(),
	timeoutMs: z.number().positive().optional().default(30_000),
})

const HttpRequestInputSchema = z.object({
	method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
	path: z.string(),
	headers: z.record(z.string()).optional(),
	query: z.record(z.string()).optional(),
	body: z.unknown().optional(),
})

// `baseUrl` is tenant-configured and reaches this at connect time (see
// manager/connector/tenant.ts), so it must not go through a `/+$` regex: on a
// string that fails to match at the tail (e.g. a long run of slashes followed
// by one more character), the engine backtracks that quantifier at every
// starting position, which is O(n^2) work a single hostile tenant can force
// onto the shared event loop. A manual scan is O(n) with no backtracking.
function stripTrailingSlashes(value: string): string {
	let end = value.length
	while (end > 0 && value[end - 1] === '/') {
		end--
	}
	return value.slice(0, end)
}

export class HttpConnector extends BaseConnector<HttpConnectorConfig> {
	readonly id = 'conn_http' as const
	readonly name = 'HTTP Connector'
	readonly description = 'Generic HTTP/REST API connector for making HTTP requests'
	readonly connectionType: ConnectionType = 'http'
	readonly configSchema = HttpConnectorConfigSchema
	readonly methods: ConnectorMethod[] = [
		{
			name: 'request',
			description: 'Make an HTTP request to the configured base URL',
			inputSchema: HttpRequestInputSchema,
		},
	]

	private baseUrl = ''
	private defaultHeaders: Record<string, string> = {}
	private timeoutMs = 30_000

	async connect(config: HttpConnectorConfig, auth?: AuthConfig): Promise<void> {
		this.config = config
		this.auth = auth
		this.baseUrl = stripTrailingSlashes(config.baseUrl)
		this.defaultHeaders = config.defaultHeaders ?? {}
		this.timeoutMs = config.timeoutMs ?? 30_000

		if (auth) {
			Object.assign(this.defaultHeaders, this.resolveAuthHeaders(auth))
		}

		this.log.info('HTTP connector connected', { 'namzu.connector.base_url': this.baseUrl })
	}

	async disconnect(): Promise<void> {
		this.config = null
		this.auth = undefined
		this.baseUrl = ''
		this.defaultHeaders = {}
		this.log.info('HTTP connector disconnected')
	}

	async healthCheck(): Promise<boolean> {
		if (!this.baseUrl) return false
		try {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), 5_000)
			const response = await fetch(this.baseUrl, {
				method: 'HEAD',
				signal: controller.signal,
			})
			clearTimeout(timeout)
			return response.ok || response.status < 500
		} catch {
			return false
		}
	}

	async execute(method: string, input: unknown): Promise<ConnectorExecuteResult> {
		this.requireMethod(method)
		const validated = this.validateInput(this.requireMethod(method), input) as HttpRequestInput

		const { result, durationMs } = await this.measureExecution(() => this.doRequest(validated))

		return {
			success: result.status >= 200 && result.status < 400,
			output: result,
			durationMs,
			metadata: {
				status: result.status,
				statusText: result.statusText,
			},
		}
	}

	private async doRequest(input: HttpRequestInput): Promise<HttpResponseOutput> {
		const url = new URL(input.path, `${this.baseUrl}/`)
		if (input.query) {
			for (const [key, value] of Object.entries(input.query)) {
				url.searchParams.set(key, value)
			}
		}

		const headers: Record<string, string> = {
			...this.defaultHeaders,
			...input.headers,
		}

		if (input.body && !headers['content-type'] && !headers['Content-Type']) {
			headers['Content-Type'] = 'application/json'
		}

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

		try {
			const response = await fetch(url.toString(), {
				method: input.method,
				headers,
				body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
				signal: controller.signal,
			})

			const responseHeaders: Record<string, string> = {}
			response.headers.forEach((value, key) => {
				responseHeaders[key] = value
			})

			let body: unknown
			const contentType = response.headers.get('content-type') ?? ''
			if (contentType.includes('application/json')) {
				body = await response.json()
			} else {
				body = await response.text()
			}

			return {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
				body,
			}
		} finally {
			clearTimeout(timeout)
		}
	}

	private resolveAuthHeaders(auth: AuthConfig): Record<string, string> {
		const creds = auth.credentials ?? {}
		switch (auth.type) {
			case 'api_key': {
				const apiKey = creds.apiKey
				if (!apiKey) throw new Error('AuthConfig api_key: missing required credential "apiKey"')
				return {
					[creds.headerName ?? 'X-API-Key']: apiKey,
				}
			}
			case 'bearer': {
				const token = creds.token
				if (!token) throw new Error('AuthConfig bearer: missing required credential "token"')
				return { Authorization: `Bearer ${token}` }
			}
			case 'basic': {
				const username = creds.username
				const password = creds.password
				if (!username || !password)
					throw new Error(
						'AuthConfig basic: missing required credentials "username" and "password"',
					)
				const encoded = btoa(`${username}:${password}`)
				return { Authorization: `Basic ${encoded}` }
			}
			case 'oauth2': {
				// Grouped with `none` until now, so a connector configured for
				// OAuth2 sent an UNAUTHENTICATED request — every other auth type
				// throws on a missing credential, and this one quietly did not.
				// The upstream answers 401 and the failure reads as a bad token
				// rather than as no token at all.
				//
				// The token exchange itself is not implemented here: a client
				// credentials or authorization-code flow needs a token endpoint,
				// refresh handling and a place to keep the result, none of which
				// belong in a request-header helper. What is supported is an
				// access token the host already holds, which is the case a
				// connector config can actually express today.
				const token = creds.accessToken ?? creds.token
				if (!token) {
					throw new Error(
						'AuthConfig oauth2: missing required credential "accessToken". This connector holds no token endpoint, so an access token obtained elsewhere has to be supplied — sending the request without one would reach the upstream unauthenticated.',
					)
				}
				return { Authorization: `Bearer ${token}` }
			}
			case 'custom':
				// Deliberately empty, unlike `oauth2` above: `custom` means the
				// host attaches its own headers, so there is nothing here to
				// omit and nothing to refuse.
				return {}
			case 'none':
				return {}
			default: {
				const _exhaustive: never = auth.type
				throw new Error(`Unhandled auth type: ${_exhaustive}`)
			}
		}
	}
}
