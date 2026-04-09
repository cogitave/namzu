import { createHmac } from 'node:crypto'
import { z } from 'zod'
import type {
	AuthConfig,
	ConnectionType,
	ConnectorExecuteResult,
	ConnectorMethod,
	WebhookConnectorConfig,
	WebhookSendInput,
	WebhookSendOutput,
} from '../../types/connector/index.js'
import { BaseConnector } from '../BaseConnector.js'

const WebhookConnectorConfigSchema = z.object({
	url: z.string().url(),
	secret: z.string().optional(),
	defaultHeaders: z.record(z.string()).optional(),
	timeoutMs: z.number().positive().optional().default(30_000),
})

const WebhookSendInputSchema = z.object({
	payload: z.unknown(),
	headers: z.record(z.string()).optional(),
	url: z.string().url().optional(),
})

export class WebhookConnector extends BaseConnector<WebhookConnectorConfig> {
	readonly id = 'webhook'
	readonly name = 'Webhook Connector'
	readonly description = 'Send webhook payloads to configured endpoints with optional HMAC signing'
	readonly connectionType: ConnectionType = 'webhook'
	readonly configSchema = WebhookConnectorConfigSchema
	readonly methods: ConnectorMethod[] = [
		{
			name: 'send',
			description: 'Send a webhook payload to the configured URL',
			inputSchema: WebhookSendInputSchema,
		},
	]

	private url = ''
	private secret: string | undefined
	private defaultHeaders: Record<string, string> = {}
	private timeoutMs = 30_000

	async connect(config: WebhookConnectorConfig, auth?: AuthConfig): Promise<void> {
		this.config = config
		this.auth = auth
		this.url = config.url
		this.secret = config.secret
		this.defaultHeaders = config.defaultHeaders ?? {}
		this.timeoutMs = config.timeoutMs ?? 30_000

		if (auth?.type === 'bearer' && auth.credentials?.token) {
			this.defaultHeaders.Authorization = `Bearer ${auth.credentials.token}`
		}

		this.log.info(`Webhook connector connected to ${this.url}`)
	}

	async disconnect(): Promise<void> {
		this.config = null
		this.auth = undefined
		this.url = ''
		this.secret = undefined
		this.defaultHeaders = {}
		this.log.info('Webhook connector disconnected')
	}

	async healthCheck(): Promise<boolean> {
		if (!this.url) return false
		try {
			const controller = new AbortController()
			const timeout = setTimeout(() => controller.abort(), 5_000)
			const response = await fetch(this.url, {
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
		const validated = this.validateInput(this.requireMethod(method), input) as WebhookSendInput

		const { result, durationMs } = await this.measureExecution(() => this.doSend(validated))

		return {
			success: result.status >= 200 && result.status < 400,
			output: result,
			durationMs,
			metadata: {
				status: result.status,
				deliveredAt: result.deliveredAt,
			},
		}
	}

	private async doSend(input: WebhookSendInput): Promise<WebhookSendOutput> {
		const targetUrl = input.url ?? this.url
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

		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

		try {
			const response = await fetch(targetUrl, {
				method: 'POST',
				headers,
				body: bodyStr,
				signal: controller.signal,
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
				body,
				deliveredAt: Date.now(),
			}
		} finally {
			clearTimeout(timeout)
		}
	}
}
