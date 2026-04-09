export interface ModelInfo {
	id: string
	name: string
	contextWindow: number
	maxOutputTokens: number
	inputPrice: number
	outputPrice: number
	supportsToolUse: boolean
	supportsStreaming: boolean
}
