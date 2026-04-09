export interface WebhookConnectorConfig {
	url: string
	secret?: string
	defaultHeaders?: Record<string, string>
	timeoutMs?: number
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
}
