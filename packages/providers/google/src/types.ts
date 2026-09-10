/** Gemini API credentials or a host-owned Gemini CLI OAuth token refresher. */
export interface GoogleConfig {
	apiKey?: string
	getAccessToken?: (signal?: AbortSignal) => Promise<string>
	projectId?: string
	model?: string
	timeoutMs?: number
	fetch?: typeof globalThis.fetch
}
export interface GoogleProviderConfig extends GoogleConfig {
	type: 'google'
}
