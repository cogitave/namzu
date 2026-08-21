import { z } from 'zod'
import type {
	AuthConfig,
	AuthType,
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorExecutionMetadata,
	ConnectorMethod,
	ConnectorOperationOptions,
	HttpConnectorConfig,
	HttpMethod,
	HttpRequestInput,
	HttpResponseOutput,
} from '../../types/connector/index.js'
import { asConnectorId } from '../../utils/id.js'
import { BaseConnector } from '../BaseConnector.js'
import {
	CONNECTOR_HEALTH_TIMEOUT_MS,
	ConnectorHttpOperation,
	DEFAULT_CONNECTOR_MAX_RESPONSE_BYTES,
	DEFAULT_CONNECTOR_REQUEST_TIMEOUT_MS,
	readConnectorResponseBody,
	requireHttpUrl,
	requireSafeConnectorInputHeaders,
	requireSameOrigin,
	validateConnectorMaxResponseBytes,
	validateConnectorTimeoutMs,
} from '../http-operation.js'

const HttpConnectorConfigSchema = z.object({
	baseUrl: z
		.string()
		.url()
		.refine((value) => /^https?:/i.test(value), 'baseUrl must use http: or https:'),
	defaultHeaders: z.record(z.string()).optional(),
	maxResponseBytes: z
		.number()
		.int()
		.positive()
		.max(2_147_483_647)
		.optional()
		.default(DEFAULT_CONNECTOR_MAX_RESPONSE_BYTES),
	timeoutMs: z
		.number()
		.int()
		.positive()
		.max(2_147_483_647)
		.optional()
		.default(DEFAULT_CONNECTOR_REQUEST_TIMEOUT_MS),
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

/**
 * Checked once at module load, not per instance.
 *
 * `'conn_http' as const` typed this as its own literal, which satisfied
 * `ConnectorId` only because the id types are still structural. The
 * constructor is what makes the prefix a fact rather than a spelling.
 */
const HTTP_CONNECTOR_ID = asConnectorId('conn_http')

export class HttpConnector extends BaseConnector<HttpConnectorConfig> {
	readonly id = HTTP_CONNECTOR_ID
	readonly name = 'HTTP Connector'
	readonly description = 'Generic HTTP/REST API connector for making HTTP requests'
	readonly connectionType: ConnectionType = 'http'
	override readonly supportedAuth: readonly AuthType[] = [
		'none',
		'api_key',
		'bearer',
		'basic',
		'oauth2',
		'custom',
	]
	readonly configSchema = HttpConnectorConfigSchema
	readonly methods: ConnectorMethod[] = [
		{
			name: 'request',
			description: 'Make an HTTP request to the configured base URL',
			inputSchema: HttpRequestInputSchema,
		},
	]

	private baseUrl = ''
	private baseOrigin = ''
	private defaultHeaders: Record<string, string> = {}
	private timeoutMs = DEFAULT_CONNECTOR_REQUEST_TIMEOUT_MS
	private maxResponseBytes = DEFAULT_CONNECTOR_MAX_RESPONSE_BYTES

	async connect(config: HttpConnectorConfig, auth?: AuthConfig): Promise<void> {
		const validated = HttpConnectorConfigSchema.parse(config)
		const baseUrl = stripTrailingSlashes(validated.baseUrl)
		const parsedBase = requireHttpUrl(baseUrl, 'HttpConnector baseUrl')
		this.config = validated
		this.auth = auth
		this.baseUrl = baseUrl
		this.baseOrigin = parsedBase.origin
		this.defaultHeaders = { ...(validated.defaultHeaders ?? {}) }
		this.timeoutMs = validateConnectorTimeoutMs(validated.timeoutMs, 'HttpConnector timeoutMs')
		this.maxResponseBytes = validateConnectorMaxResponseBytes(
			validated.maxResponseBytes,
			'HttpConnector maxResponseBytes',
		)

		if (auth) {
			Object.assign(this.defaultHeaders, this.resolveAuthHeaders(auth))
		}

		this.log.info('HTTP connector connected', {
			'namzu.connector.base_url': this.baseUrl,
		})
	}

	async disconnect(): Promise<void> {
		this.config = null
		this.auth = undefined
		this.baseUrl = ''
		this.baseOrigin = ''
		this.defaultHeaders = {}
		this.log.info('HTTP connector disconnected')
	}

	async healthCheck(options?: ConnectorOperationOptions): Promise<boolean> {
		if (!this.baseUrl) return false
		let operation: ConnectorHttpOperation | undefined
		try {
			operation = new ConnectorHttpOperation(
				options?.signal,
				CONNECTOR_HEALTH_TIMEOUT_MS,
				'HTTP connector health check',
			)
			const activeOperation = operation
			const response = await activeOperation.run(() =>
				fetch(this.baseUrl, {
					method: 'HEAD',
					redirect: 'manual',
					signal: activeOperation.signal,
				}),
			)
			return response.ok || response.status < 500
		} catch {
			return false
		} finally {
			operation?.close()
		}
	}

	async execute(
		method: string,
		input: unknown,
		options?: ConnectorOperationOptions,
	): Promise<ConnectorExecuteResult> {
		this.requireMethod(method)
		const validated = (await this.validateInput(
			this.requireMethod(method),
			input,
			options,
		)) as HttpRequestInput
		const startedAt = performance.now()
		if (options?.signal?.aborted) {
			return this.notStarted(validated.method, options.signal.reason, startedAt)
		}
		return this.doRequest(validated, options, startedAt)
	}

	private async doRequest(
		input: HttpRequestInput,
		options: ConnectorOperationOptions | undefined,
		startedAt: number,
	): Promise<ConnectorExecuteResult> {
		const url = new URL(input.path, `${this.baseUrl}/`)
		requireSameOrigin(url.toString(), this.baseOrigin, 'HttpConnector request URL')
		requireSafeConnectorInputHeaders(input.headers, 'HttpConnector request headers')
		if (input.query) {
			for (const [key, value] of Object.entries(input.query)) {
				url.searchParams.set(key, value)
			}
		}

		const headers: Record<string, string> = {
			...this.defaultHeaders,
			...input.headers,
		}

		if (input.body !== undefined && !headers['content-type'] && !headers['Content-Type']) {
			headers['Content-Type'] = 'application/json'
		}

		let operation: ConnectorHttpOperation | undefined

		try {
			try {
				operation = new ConnectorHttpOperation(
					options?.signal,
					this.timeoutMs,
					`HTTP connector ${input.method}`,
				)
			} catch (error) {
				return this.notStarted(input.method, error, startedAt)
			}
			let response: Response
			try {
				const activeOperation = operation
				response = await activeOperation.run(() =>
					fetch(url.toString(), {
						method: input.method,
						headers,
						body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
						redirect: 'manual',
						signal: activeOperation.signal,
					}),
				)
			} catch (error) {
				return this.unknownOutcome(input.method, error, startedAt)
			}

			const responseHeaders: Record<string, string> = {}
			response.headers.forEach((value, key) => {
				responseHeaders[key] = value
			})

			const retrySafety = this.retrySafety(input.method)
			const metadata: ConnectorExecutionMetadata = {
				status: response.status,
				statusText: response.statusText,
				remoteOutcome: 'response_received',
				retrySafety,
				bodyAvailable: true,
			}
			let body: unknown
			try {
				body = await readConnectorResponseBody(response, operation, this.maxResponseBytes)
			} catch (error) {
				const bodyError = `Response body unavailable: ${this.errorText(error)}`
				const output: HttpResponseOutput = {
					status: response.status,
					statusText: response.statusText,
					headers: responseHeaders,
					body: null,
					bodyAvailable: false,
					bodyError,
					remoteOutcome: 'response_received',
					retrySafety,
				}
				metadata.bodyAvailable = false
				return {
					success: response.status >= 200 && response.status < 300,
					output,
					...(response.status < 200 || response.status >= 300
						? { error: this.statusError(response, retrySafety, true) }
						: {}),
					durationMs: this.duration(startedAt),
					metadata,
				}
			}

			const output: HttpResponseOutput = {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
				body,
				bodyAvailable: true,
				remoteOutcome: 'response_received',
				retrySafety,
			}
			return {
				success: response.status >= 200 && response.status < 300,
				output,
				...(response.status < 200 || response.status >= 300
					? { error: this.statusError(response, retrySafety, false) }
					: {}),
				durationMs: this.duration(startedAt),
				metadata,
			}
		} finally {
			operation?.close()
		}
	}

	private notStarted(
		method: HttpMethod,
		reason: unknown,
		startedAt: number,
	): ConnectorExecuteResult {
		return {
			success: false,
			output: null,
			error: `HTTP ${method} was cancelled before it started: ${this.errorText(reason)}. No remote request was started; retry is safe.`,
			durationMs: this.duration(startedAt),
			metadata: {
				remoteOutcome: 'not_started',
				retrySafety: 'safe',
				bodyAvailable: false,
			},
		}
	}

	private unknownOutcome(
		method: HttpMethod,
		error: unknown,
		startedAt: number,
	): ConnectorExecuteResult {
		const retrySafety = this.retrySafety(method)
		const advice =
			retrySafety === 'safe'
				? `Retry is safe because ${method} is a safe HTTP method.`
				: 'Do not automatically retry this request; it may duplicate a remote side effect.'
		return {
			success: false,
			output: null,
			error: `HTTP ${method} produced no response: ${this.errorText(error)}. The remote outcome is unknown. ${advice}`,
			durationMs: this.duration(startedAt),
			metadata: { remoteOutcome: 'unknown', retrySafety, bodyAvailable: false },
		}
	}

	private statusError(
		response: Response,
		retrySafety: 'safe' | 'unsafe',
		bodyMissing: boolean,
	): string {
		const retry =
			retrySafety === 'safe'
				? 'Retry is safe for this HTTP method.'
				: 'Do not automatically retry; the remote side effect may already have happened.'
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location')
			return `HTTP ${response.status}: ${response.statusText}. The redirect was not followed because connector requests cannot leave their configured origin.${location ? ` Location: ${location}.` : ''} ${retry}`
		}
		return `HTTP ${response.status}: ${response.statusText}.${bodyMissing ? ' The response body was unavailable.' : ''} ${retry}`
	}

	private retrySafety(method: HttpMethod): 'safe' | 'unsafe' {
		return method === 'GET' || method === 'HEAD' ? 'safe' : 'unsafe'
	}

	private duration(startedAt: number): number {
		return Math.round(performance.now() - startedAt)
	}

	private errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
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
