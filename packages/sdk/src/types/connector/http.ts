export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD'

export interface HttpConnectorConfig {
	baseUrl: string
	defaultHeaders?: Record<string, string>
	timeoutMs?: number
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
}
