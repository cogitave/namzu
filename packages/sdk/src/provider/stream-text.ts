import { type AssistantTextPart, selectAssistantText } from '../types/message/index.js'
import type { StreamChunk } from '../types/provider/stream.js'

/** Shared aggregation for the run loop, collected calls and bounded auxiliary inference. */
export class StreamTextAccumulator {
	private raw = ''
	private receivedCharacters = 0
	private parts: AssistantTextPart[] = []
	private identified = false
	private snapshot = false

	push(chunk: StreamChunk): void {
		if (chunk.textParts !== undefined) {
			this.parts = chunk.textParts.map((part) => ({ ...part }))
			this.identified = true
			this.snapshot = true
			this.raw = ''
		}
		const text = chunk.delta.content
		if (!text) return
		if (this.snapshot) throw new Error('Content arrived after the completed text snapshot.')
		this.receivedCharacters += text.length
		const part = chunk.delta.textPart
		if (!this.identified && !part) {
			this.raw += text
			return
		}
		if (!this.identified) {
			if (this.raw) this.parts.push({ id: '', text: this.raw })
			this.raw = ''
			this.identified = true
		}
		const previous = this.parts.at(-1)
		if (previous && previous.id === (part?.id ?? '') && previous.phase === part?.phase)
			this.parts[this.parts.length - 1] = { ...previous, text: previous.text + text }
		else
			this.parts.push({ id: part?.id ?? '', ...(part?.phase ? { phase: part.phase } : {}), text })
	}

	get text(): string {
		return this.identified ? selectAssistantText(this.parts) : this.raw
	}

	/** Include commentary in auxiliary output limits even when only the final answer is selected. */
	get characters(): number {
		return Math.max(
			this.receivedCharacters,
			this.parts.reduce((sum, part) => sum + part.text.length, 0) +
				Math.max(0, this.parts.length - 1) * 2,
		)
	}

	get textParts(): readonly AssistantTextPart[] | undefined {
		return this.identified ? this.parts.map((part) => ({ ...part })) : undefined
	}
}
