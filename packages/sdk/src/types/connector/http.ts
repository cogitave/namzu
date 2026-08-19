import type { ConnectorRemoteOutcome, ConnectorRetrySafety } from './definition.js'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

export interface HttpConnectorConfig {
	baseUrl: string
	defaultHeaders?: Record<string, string>
	timeoutMs?: number
	maxResponseBytes?: number
}

export interface HttpRequestInput {
	method: HttpMethod
	path: string
	headers?: Record<string, string>
	query?: Record<string, string>
	body?: unknown
}

export interface HttpResponseOutput {
	status: number
	statusText: string
	headers: Record<string, string>
	body: unknown
	bodyAvailable?: boolean
	bodyError?: string
	remoteOutcome?: ConnectorRemoteOutcome
	retrySafety?: ConnectorRetrySafety
}
