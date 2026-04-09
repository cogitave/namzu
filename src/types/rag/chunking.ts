export type ChunkingStrategy = 'fixed' | 'sentence' | 'paragraph' | 'recursive'

export interface ChunkingConfig {
	strategy: ChunkingStrategy
	chunkSize: number
	chunkOverlap: number
	separators?: string[]
}

export interface Chunker {
	chunk(content: string, config: ChunkingConfig): ChunkContent[]
}

export interface ChunkContent {
	content: string
	index: number
}
