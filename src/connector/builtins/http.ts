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

export class HttpConnector extends BaseConnector<HttpConnectorConfig> {
	readonly id = 'http'
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
		this.baseUrl = config.baseUrl.replace(/\/+$/, '')
		this.defaultHeaders = config.defaultHeaders ?? {}
		this.timeoutMs = config.timeoutMs ?? 30_000

		if (auth) {
			Object.assign(this.defaultHeaders, this.resolveAuthHeaders(auth))
		}

		this.log.info(`HTTP connector connected to ${this.baseUrl}`)
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
			case 'none':
			case 'oauth2':
			case 'custom':
				return {}
			default: {
				const _exhaustive: never = auth.type
				throw new Error(`Unhandled auth type: ${_exhaustive}`)
			}
		}
	}
}
