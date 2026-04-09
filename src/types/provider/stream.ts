import type { TokenUsage } from '../common/index.js'

export interface StreamChunk {
	id: string
	delta: {
		content?: string
		toolCalls?: Array<{
			index: number
			id?: string
			type?: 'function'
			function?: {
				name?: string
				arguments?: string
			}
		}>
	}
	finishReason?: 'stop' | 'tool_calls' | 'length' | 'content_filter'
	usage?: TokenUsage
	error?: string
}
