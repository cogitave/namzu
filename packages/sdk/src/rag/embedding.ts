import type { EmbeddingProvider, OpenRouterEmbeddingConfig } from '../types/rag/index.js'

export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
	readonly id = 'openrouter-embedding'
	readonly model: string
	readonly dimensions: number

	private readonly apiKey: string
	private readonly baseUrl: string
	private readonly batchSize: number

	constructor(config: OpenRouterEmbeddingConfig) {
		this.model = config.model
		this.dimensions = config.dimensions ?? 1536
		this.apiKey = config.apiKey
		this.baseUrl = config.baseUrl ?? 'https://openrouter.ai/api/v1'
		this.batchSize = config.batchSize ?? 64
	}

	async embed(texts: string[]): Promise<number[][]> {
		const results: number[][] = []

		for (let i = 0; i < texts.length; i += this.batchSize) {
			const batch = texts.slice(i, i + this.batchSize)
			const batchResults = await this.callEmbeddingApi(batch)
			results.push(...batchResults)
		}

		return results
	}

	async embedQuery(query: string): Promise<number[]> {
		const [result] = await this.embed([query])
		if (!result) {
			throw new Error('Embedding returned no results')
		}
		return result
	}

	private async callEmbeddingApi(texts: string[]): Promise<number[][]> {
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
		})

		if (!response.ok) {
			const errorText = await response.text()
			throw new Error(`Embedding API error (${response.status}): ${errorText}`)
		}

		const data = (await response.json()) as EmbeddingApiResponse
		return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
	}
}

interface EmbeddingApiResponse {
	data: Array<{
		index: number
		embedding: number[]
	}>
	usage: {
		prompt_tokens: number
		total_tokens: number
	}
}
