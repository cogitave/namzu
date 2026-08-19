import type { RAGOperationOptions } from './scope.js'

export interface EmbeddingProvider {
	readonly id: string
	readonly model: string
	readonly dimensions: number

	/**
	 * Implementations should stop owned I/O when `options.signal` aborts.
	 * A caller still bounds its own wait: a custom provider may be
	 * non-cooperative, just as any other host-supplied implementation may be.
	 */
	embed(texts: string[], options?: RAGOperationOptions): Promise<number[][]>
	embedQuery(query: string, options?: RAGOperationOptions): Promise<number[]>
}

export interface EmbeddingConfig {
	model: string
	/** Expected positive vector width. HTTP responses with another width are refused. */
	dimensions?: number
	/** Positive number of inputs sent in one operation. */
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
	/**
	 * Whole-request bound for each HTTP batch, including response-body reads.
	 * Defaults to 30 seconds. Set `0` to preserve the former unbounded behavior.
	 */
	requestTimeoutMs?: number
}
