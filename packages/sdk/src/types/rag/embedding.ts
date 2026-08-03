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

/**
 * Config for {@link HttpEmbeddingProvider}.
 *
 * `baseUrl` is REQUIRED. It used to default to one vendor's host, which
 * meant a caller who never named an endpoint still sent its text to one —
 * a default network destination is a decision the caller has to make out
 * loud.
 */
export interface HttpEmbeddingConfig extends EmbeddingConfig {
	apiKey: string
	/** Root of an embeddings API; `/embeddings` is appended. */
	baseUrl: string
}
