import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type {
	AuthConfig,
	AuthType,
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorExecutionMetadata,
	ConnectorMethod,
	ConnectorOperationOptions,
	WebhookConnectorConfig,
	WebhookSendInput,
	WebhookSendOutput,
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

const WebhookConnectorConfigSchema = z.object({
	url: z
		.string()
		.url()
		.refine((value) => /^https?:/i.test(value), 'url must use http: or https:'),
	secret: z.string().optional(),
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

const WebhookSendInputSchema = z.object({
	payload: z.unknown(),
	headers: z.record(z.string()).optional(),
	url: z.string().url().optional(),
})

/** Checked once at module load — see `HttpConnector`'s own constant. */
const WEBHOOK_CONNECTOR_ID = asConnectorId('conn_webhook')

export class WebhookConnector extends BaseConnector<WebhookConnectorConfig> {
	readonly id = WEBHOOK_CONNECTOR_ID
	readonly name = 'Webhook Connector'
	readonly description = 'Send webhook payloads to configured endpoints with optional HMAC signing'
	readonly connectionType: ConnectionType = 'webhook'
	override readonly supportedAuth: readonly AuthType[] = ['none', 'bearer']
	readonly configSchema = WebhookConnectorConfigSchema
	readonly methods: ConnectorMethod[] = [
		{
			name: 'send',
			description: 'Send a webhook payload to the configured URL',
			inputSchema: WebhookSendInputSchema,
		},
	]

	private url = ''
	private origin = ''
	private secret: string | undefined
	private defaultHeaders: Record<string, string> = {}
	private timeoutMs = DEFAULT_CONNECTOR_REQUEST_TIMEOUT_MS
	private maxResponseBytes = DEFAULT_CONNECTOR_MAX_RESPONSE_BYTES

	async connect(config: WebhookConnectorConfig, auth?: AuthConfig): Promise<void> {
		const validated = WebhookConnectorConfigSchema.parse(config)
		const parsedUrl = requireHttpUrl(validated.url, 'WebhookConnector url')
		this.config = validated
		this.auth = auth
		this.url = validated.url
		this.origin = parsedUrl.origin
		this.secret = validated.secret
		this.defaultHeaders = { ...(validated.defaultHeaders ?? {}) }
		this.timeoutMs = validateConnectorTimeoutMs(validated.timeoutMs, 'WebhookConnector timeoutMs')
		this.maxResponseBytes = validateConnectorMaxResponseBytes(
			validated.maxResponseBytes,
			'WebhookConnector maxResponseBytes',
		)

		if (auth?.type === 'bearer' && auth.credentials?.token) {
			this.defaultHeaders.Authorization = `Bearer ${auth.credentials.token}`
		}

		this.log.info('Webhook connector connected', {
			'namzu.connector.url': this.url,
		})
	}

	async disconnect(): Promise<void> {
		this.config = null
		this.auth = undefined
		this.url = ''
		this.origin = ''
		this.secret = undefined
		this.defaultHeaders = {}
		this.log.info('Webhook connector disconnected')
	}

	async healthCheck(options?: ConnectorOperationOptions): Promise<boolean> {
		if (!this.url) return false
		let operation: ConnectorHttpOperation | undefined
		try {
			operation = new ConnectorHttpOperation(
				options?.signal,
				CONNECTOR_HEALTH_TIMEOUT_MS,
				'Webhook connector health check',
			)
			const activeOperation = operation
			const response = await activeOperation.run(() =>
				fetch(this.url, {
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
		const validated = this.validateInput(this.requireMethod(method), input) as WebhookSendInput
		const startedAt = performance.now()
		if (options?.signal?.aborted) {
			return this.notStarted(options.signal.reason, startedAt)
		}
		return this.doSend(validated, options, startedAt)
	}

	private async doSend(
		input: WebhookSendInput,
		options: ConnectorOperationOptions | undefined,
		startedAt: number,
	): Promise<ConnectorExecuteResult> {
		const targetUrl = input.url ?? this.url
		requireSameOrigin(targetUrl, this.origin, 'WebhookConnector request URL')
		requireSafeConnectorInputHeaders(input.headers, 'WebhookConnector request headers')
		const bodyStr = JSON.stringify(input.payload)

		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
			...this.defaultHeaders,
			...input.headers,
		}

		if (this.secret) {
			const signature = createHmac('sha256', this.secret).update(bodyStr).digest('hex')
			headers['X-Webhook-Signature'] = `sha256=${signature}`
		}

		let operation: ConnectorHttpOperation | undefined

		try {
			try {
				operation = new ConnectorHttpOperation(
					options?.signal,
					this.timeoutMs,
					'Webhook connector POST',
				)
			} catch (error) {
				return this.notStarted(error, startedAt)
			}
			let response: Response
			try {
				const activeOperation = operation
				response = await activeOperation.run(() =>
					fetch(targetUrl, {
						method: 'POST',
						headers,
						body: bodyStr,
						redirect: 'manual',
						signal: activeOperation.signal,
					}),
				)
			} catch (error) {
				return this.unknownOutcome(error, startedAt)
			}

			const deliveredAt = Date.now()
			const metadata: ConnectorExecutionMetadata = {
				status: response.status,
				deliveredAt,
				remoteOutcome: 'response_received',
				retrySafety: 'unsafe',
				bodyAvailable: true,
			}
			const redirectLocation = response.headers.get('location')
			if (redirectLocation) metadata.redirectLocation = redirectLocation
			let body: unknown
			try {
				body = await readConnectorResponseBody(response, operation, this.maxResponseBytes)
			} catch (error) {
				const output: WebhookSendOutput = {
					status: response.status,
					body: null,
					deliveredAt,
					bodyAvailable: false,
					bodyError: `Response body unavailable: ${this.errorText(error)}`,
					remoteOutcome: 'response_received',
					retrySafety: 'unsafe',
				}
				metadata.bodyAvailable = false
				return {
					success: response.status >= 200 && response.status < 300,
					output,
					...(response.status < 200 || response.status >= 300
						? { error: this.statusError(response, true) }
						: {}),
					durationMs: this.duration(startedAt),
					metadata,
				}
			}

			const output: WebhookSendOutput = {
				status: response.status,
				body,
				deliveredAt,
				bodyAvailable: true,
				remoteOutcome: 'response_received',
				retrySafety: 'unsafe',
			}
			return {
				success: response.status >= 200 && response.status < 300,
				output,
				...(response.status < 200 || response.status >= 300
					? { error: this.statusError(response, false) }
					: {}),
				durationMs: this.duration(startedAt),
				metadata,
			}
		} finally {
			operation?.close()
		}
	}

	private notStarted(reason: unknown, startedAt: number): ConnectorExecuteResult {
		return {
			success: false,
			output: null,
			error: `Webhook POST was cancelled before it started: ${this.errorText(reason)}. No remote request was started; retry is safe.`,
			durationMs: this.duration(startedAt),
			metadata: {
				remoteOutcome: 'not_started',
				retrySafety: 'safe',
				bodyAvailable: false,
			},
		}
	}

	private unknownOutcome(error: unknown, startedAt: number): ConnectorExecuteResult {
		return {
			success: false,
			output: null,
			error: `Webhook POST produced no response: ${this.errorText(error)}. The remote outcome is unknown. Do not automatically retry this request; it may duplicate a delivery.`,
			durationMs: this.duration(startedAt),
			metadata: {
				remoteOutcome: 'unknown',
				retrySafety: 'unsafe',
				bodyAvailable: false,
			},
		}
	}

	private statusError(response: Response, bodyMissing: boolean): string {
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get('location')
			return `HTTP ${response.status}: ${response.statusText}. The redirect was not followed because webhook requests cannot leave their configured origin.${location ? ` Location: ${location}.` : ''} Do not automatically retry; the webhook may already have been applied.`
		}
		return `HTTP ${response.status}: ${response.statusText}.${bodyMissing ? ' The response body was unavailable.' : ''} Do not automatically retry; the webhook may already have been applied.`
	}

	private duration(startedAt: number): number {
		return Math.round(performance.now() - startedAt)
	}

	private errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}
}
