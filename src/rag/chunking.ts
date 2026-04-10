import { DEFAULT_CHUNKING_CONFIG, DEFAULT_SEPARATORS } from '../constants/rag/index.js'
import type { ChunkContent, Chunker, ChunkingConfig } from '../types/rag/index.js'

export class TextChunker implements Chunker {
	chunk(content: string, config: ChunkingConfig): ChunkContent[] {
		switch (config.strategy) {
			case 'fixed':
				return this.fixedChunk(content, config)
			case 'sentence':
				return this.sentenceChunk(content, config)
			case 'paragraph':
				return this.paragraphChunk(content, config)
			case 'recursive':
				return this.recursiveChunk(content, config)
			default: {
				const _exhaustive: never = config.strategy
				throw new Error(`Unhandled chunking strategy: ${_exhaustive}`)
			}
		}
	}

	private fixedChunk(content: string, config: ChunkingConfig): ChunkContent[] {
		const { chunkSize, chunkOverlap } = config
		const chunks: ChunkContent[] = []
		const step = Math.max(1, chunkSize - chunkOverlap)
		let idx = 0

		for (let start = 0; start < content.length; start += step) {
			const slice = content.slice(start, start + chunkSize).trim()
			if (slice.length > 0) {
				chunks.push({ content: slice, index: idx++ })
			}
		}
		return chunks
	}

	private sentenceChunk(content: string, config: ChunkingConfig): ChunkContent[] {
		const separators = config.separators ?? DEFAULT_SEPARATORS.sentence
		const sentences = this.splitBySeparators(content, separators)
		return this.mergeSmallParts(sentences, config)
	}

	private paragraphChunk(content: string, config: ChunkingConfig): ChunkContent[] {
		const separators = config.separators ?? DEFAULT_SEPARATORS.paragraph
		const paragraphs = this.splitBySeparators(content, separators)
		return this.mergeSmallParts(paragraphs, config)
	}

	private recursiveChunk(content: string, config: ChunkingConfig): ChunkContent[] {
		const separators = config.separators ?? DEFAULT_SEPARATORS.recursive
		return this.recursiveSplit(content, separators, config, 0)
	}

	private recursiveSplit(
		text: string,
		separators: string[],
		config: ChunkingConfig,
		startIndex: number,
	): ChunkContent[] {
		if (text.length <= config.chunkSize) {
			const trimmed = text.trim()
			return trimmed.length > 0 ? [{ content: trimmed, index: startIndex }] : []
		}

		for (const sep of separators) {
			const parts = sep === '' ? [...text] : text.split(sep).filter((p) => p.trim().length > 0)
			if (parts.length <= 1) continue

			const remaining = separators.slice(separators.indexOf(sep) + 1)
			const merged = this.mergeSmallParts(parts, config)

			if (merged.every((c) => c.content.length <= config.chunkSize)) {
				return merged
			}

			const results: ChunkContent[] = []
			let idx = 0
			for (const chunk of merged) {
				if (chunk.content.length > config.chunkSize && remaining.length > 0) {
					const subChunks = this.recursiveSplit(chunk.content, remaining, config, idx)
					results.push(...subChunks)
					idx += subChunks.length
				} else {
					results.push({ content: chunk.content, index: idx++ })
				}
			}
			return results
		}

		return this.fixedChunk(text, config)
	}

	private splitBySeparators(text: string, separators: string[]): string[] {
		let parts = [text]
		for (const sep of separators) {
			const nextParts: string[] = []
			for (const part of parts) {
				const splits = part.split(sep)
				for (const [i, segment] of splits.entries()) {
					const piece = i < splits.length - 1 ? segment + sep : segment
					if (piece.trim().length > 0) {
						nextParts.push(piece)
					}
				}
			}
			parts = nextParts
		}
		return parts
	}

	private mergeSmallParts(parts: string[], config: ChunkingConfig): ChunkContent[] {
		const { chunkSize, chunkOverlap } = config
		const chunks: ChunkContent[] = []
		let current = ''
		let idx = 0

		for (const part of parts) {
			if (current.length + part.length > chunkSize && current.length > 0) {
				chunks.push({ content: current.trim(), index: idx++ })
				const overlapStart = Math.max(0, current.length - chunkOverlap)
				current = current.slice(overlapStart) + part
			} else {
				current += part
			}
		}

		if (current.trim().length > 0) {
			chunks.push({ content: current.trim(), index: idx })
		}

		return chunks
	}
}

export { DEFAULT_CHUNKING_CONFIG }
