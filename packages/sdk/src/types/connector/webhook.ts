import type { ConnectorRemoteOutcome, ConnectorRetrySafety } from './definition.js'

export interface WebhookConnectorConfig {
	url: string
	secret?: string
	defaultHeaders?: Record<string, string>
	timeoutMs?: number
	maxResponseBytes?: number
}

export interface WebhookSendInput {
	payload: unknown
	headers?: Record<string, string>
	url?: string
}

export interface WebhookSendOutput {
	status: number
	body: unknown
	deliveredAt: number
	bodyAvailable?: boolean
	bodyError?: string
	remoteOutcome?: ConnectorRemoteOutcome
	retrySafety?: ConnectorRetrySafety
}
