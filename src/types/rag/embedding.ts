export interface EmbeddingProvider {
	readonly id: string
	readonly model: string
	readonly dimensions: number

	embed(texts: string[]): Promise<number[][]>
	embedQuery(query: string): Promise<number[]>
}

export interface EmbeddingConfig {
	model: string
	dimensions?: number
	batchSize?: number
}

export interface OpenRouterEmbeddingConfig extends EmbeddingConfig {
	apiKey: string
	baseUrl?: string
}
