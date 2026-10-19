import type { LLMProvider } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'
import { TextOnlyModels } from './image-input.js'

class Fixture implements LLMProvider {
	readonly id = 'zen'
	readonly name = 'Zen'
	private readonly secret = 'kept'
	supportsImageInputFor(model: string): boolean {
		return model !== 'beam'
	}
	async *chatStream() {
		yield { id: 'x', delta: { content: this.secret } }
	}
}

describe('TextOnlyModels', () => {
	it('combines the driver catalogue with what this conversation learned', () => {
		const known = new TextOnlyModels()
		const provider = new Fixture()
		expect(known.reads(provider, 'beam')).toBe(false)
		expect(known.reads(provider, 'seer')).toBe(true)
		known.add('zen', 'seer')
		expect(known.reads(provider, 'seer')).toBe(false)
		expect(known.reads(provider, 'other')).toBe(true)
	})

	it('answers for learned models through the provider it wraps, without losing the rest of it', async () => {
		const known = new TextOnlyModels()
		const original = new Fixture()
		// Nothing learned: the provider itself, so identity-keyed code still finds it.
		expect(known.informing(original)).toBe(original)
		known.add('zen', 'seer')
		const wrapped = known.informing(original)
		expect(wrapped).not.toBe(original)
		expect(wrapped.supportsImageInputFor?.('seer')).toBe(false)
		expect(wrapped.supportsImageInputFor?.('other')).toBe(true)
		expect(wrapped.id).toBe('zen')
		const chunks = []
		for await (const chunk of wrapped.chatStream({} as never)) chunks.push(chunk)
		expect(chunks[0]?.delta.content).toBe('kept')
	})
})
