import type {
	EmbeddingProvider,
	HttpEmbeddingConfig,
	RAGOperationOptions,
} from '../types/rag/index.js'

/** Each HTTP embedding batch owns a finite transport lifetime by default. */
export const DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS = 30_000

const MAX_TIMER_DELAY_MS = 2_147_483_647

function resolveRequestTimeoutMs(value: number | undefined): number {
	const resolved = value ?? DEFAULT_EMBEDDING_REQUEST_TIMEOUT_MS
	if (!Number.isInteger(resolved) || resolved < 0 || resolved > MAX_TIMER_DELAY_MS) {
		throw new RangeError(
			`requestTimeoutMs must be an integer from 0 to ${MAX_TIMER_DELAY_MS}; received ${String(resolved)}`,
		)
	}
	return resolved
}

function resolveBatchSize(value: number | undefined): number {
	const resolved = value ?? 64
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new RangeError(`batchSize must be a positive safe integer; received ${String(resolved)}`)
	}
	return resolved
}

function resolveDimensions(value: number | undefined): number {
	const resolved = value ?? 1536
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new RangeError(`dimensions must be a positive safe integer; received ${String(resolved)}`)
	}
	return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

/**
 * Embeddings over the common HTTP shape: `POST {baseUrl}/embeddings` with
 * a bearer key, `{ model, input, dimensions }` in, `{ data: [{ index,
 * embedding }] }` out. Every hosted embeddings service worth pointing at
 * speaks it, so the driver is the shape rather than any one host.
 */
/**
 * Trim trailing slashes without a regex.
 *
 * `/\/+$/` backtracks quadratically on a long run of slashes, and this
 * value crosses a trust boundary — a host-supplied endpoint on a shared
 * event loop. The scan is linear and says the same thing.
 */
function stripTrailingSlashes(value: string): string {
	let end = value.length
	while (end > 0 && value[end - 1] === '/') {
		end--
	}
	return value.slice(0, end)
}

export class HttpEmbeddingProvider implements EmbeddingProvider {
	readonly id = 'http-embedding'
	readonly model: string
	readonly dimensions: number

	private readonly apiKey: string
	private readonly baseUrl: string
	private readonly batchSize: number
	private readonly requestTimeoutMs: number

	constructor(config: HttpEmbeddingConfig) {
		this.model = config.model
		this.dimensions = resolveDimensions(config.dimensions)
		this.apiKey = config.apiKey
		this.baseUrl = stripTrailingSlashes(config.baseUrl)
		this.batchSize = resolveBatchSize(config.batchSize)
		this.requestTimeoutMs = resolveRequestTimeoutMs(config.requestTimeoutMs)
	}

	async embed(texts: string[], options: RAGOperationOptions = {}): Promise<number[][]> {
		options.signal?.throwIfAborted()
		const results: number[][] = []

		for (let i = 0; i < texts.length; i += this.batchSize) {
			const batch = texts.slice(i, i + this.batchSize)
			const batchResults = await this.callEmbeddingApi(batch, options.signal)
			results.push(...batchResults)
		}

		return results
	}

	async embedQuery(query: string, options: RAGOperationOptions = {}): Promise<number[]> {
		const [result] = await this.embed([query], options)
		if (!result) {
			throw new Error('Embedding returned no results')
		}
		return result
	}

	private async callEmbeddingApi(texts: string[], callerSignal?: AbortSignal): Promise<number[][]> {
		callerSignal?.throwIfAborted()

		// The provider owns this controller. A caller cancellation flows into it,
		// while the provider's deadline never aborts the caller's controller.
		const transport = new AbortController()
		let rejectCallerAbort: ((reason?: unknown) => void) | undefined
		const callerAbort = callerSignal
			? new Promise<never>((_resolve, reject) => {
					rejectCallerAbort = reject
				})
			: undefined
		const onCallerAbort = (): void => {
			const reason = callerSignal?.reason
			// Settle the public operation with the caller's exact reason before
			// aborting fetch: transports commonly turn every abort into a generic
			// DOMException, which would erase who stopped the run.
			rejectCallerAbort?.(reason)
			if (!transport.signal.aborted) transport.abort(reason)
		}
		callerSignal?.addEventListener('abort', onCallerAbort, { once: true })

		let timer: ReturnType<typeof setTimeout> | undefined
		const timeout =
			this.requestTimeoutMs > 0
				? new Promise<never>((_resolve, reject) => {
						timer = setTimeout(() => {
							const error = new Error(
								`Embedding request timed out after ${this.requestTimeoutMs}ms`,
							)
							error.name = 'TimeoutError'
							reject(error)
							if (!transport.signal.aborted) transport.abort(error)
						}, this.requestTimeoutMs)
					})
				: undefined

		const request = this.performEmbeddingRequest(texts, transport.signal)
		// A custom or polyfilled fetch may ignore AbortSignal and reject later.
		// Once the operation has settled, that late rejection is not allowed to
		// become an unhandled process error.
		request.catch(() => {})

		try {
			return await Promise.race([
				request,
				...(callerAbort ? [callerAbort] : []),
				...(timeout ? [timeout] : []),
			])
		} finally {
			if (timer !== undefined) clearTimeout(timer)
			callerSignal?.removeEventListener('abort', onCallerAbort)
		}
	}

	private async performEmbeddingRequest(texts: string[], signal: AbortSignal): Promise<number[][]> {
		const response = await fetch(`${this.baseUrl}/embeddings`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				model: this.model,
				input: texts,
				dimensions: this.dimensions,
			}),
			signal,
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Embedding API error (${response.status}): ${errorText}`)
		}

		return this.validateEmbeddingResponse(await response.json(), texts.length)
	}

	private validateEmbeddingResponse(value: unknown, expectedCount: number): number[][] {
		if (!isRecord(value) || !Array.isArray(value.data)) {
			throw new Error('Embedding API response must contain a data array')
		}
		if (value.data.length !== expectedCount) {
			throw new Error(
				`Embedding API returned ${value.data.length} vectors for ${expectedCount} inputs`,
			)
		}

		const embeddings = new Array<number[]>(expectedCount)
		const seen = new Set<number>()
		for (const item of value.data) {
			if (!isRecord(item) || !Number.isSafeInteger(item.index)) {
				throw new Error('Embedding API response contains a non-integer index')
			}
			const index = item.index as number
			if (index < 0 || index >= expectedCount) {
				throw new Error(`Embedding API response index ${index} is outside the input range`)
			}
			if (seen.has(index)) {
				throw new Error(`Embedding API response contains duplicate index ${index}`)
			}
			if (
				!Array.isArray(item.embedding) ||
				item.embedding.length !== this.dimensions ||
				!item.embedding.every(
					(coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate),
				)
			) {
				throw new Error(
					`Embedding API response index ${index} must contain ${this.dimensions} finite numbers`,
				)
			}

			seen.add(index)
			embeddings[index] = item.embedding
		}

		return embeddings
	}
}
