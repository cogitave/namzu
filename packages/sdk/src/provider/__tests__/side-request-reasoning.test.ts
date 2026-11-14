import { describe, expect, it } from 'vitest'
import type { ChatCompletionParams, LLMProvider, StreamChunk } from '../../types/provider/index.js'
import {
	SIDE_REQUEST_REASONING_HEADROOM,
	chatStreamForSideRequest,
	sideRequestReasoning,
} from '../side-request-reasoning.js'

describe('sideRequestReasoning', () => {
	it('switches reasoning off when the driver offers none', () => {
		const provider = { reasoningEffortLevelsFor: () => ['none', 'low', 'high'] as const }
		expect(sideRequestReasoning(provider, 'm', 60)).toEqual({
			thinking: { type: 'disabled' },
			effort: 'none',
			maxTokens: 60,
		})
	})

	it('asks for the lowest level and leaves room when the model cannot stop reasoning', () => {
		const provider = { reasoningEffortLevelsFor: () => ['medium', 'low', 'high'] as const }
		expect(sideRequestReasoning(provider, 'm', 60)).toEqual({
			effort: 'low',
			maxTokens: 60 + SIDE_REQUEST_REASONING_HEADROOM,
		})
	})

	it('sends disabled thinking and leaves room when the driver cannot say', () => {
		expect(sideRequestReasoning({}, 'm', 512)).toEqual({
			thinking: { type: 'disabled' },
			maxTokens: 512 + SIDE_REQUEST_REASONING_HEADROOM,
		})
		expect(sideRequestReasoning({ reasoningEffortLevelsFor: () => undefined }, 'm', 512)).toEqual({
			thinking: { type: 'disabled' },
			maxTokens: 512 + SIDE_REQUEST_REASONING_HEADROOM,
		})
	})
})

function fake(onRequest: (params: ChatCompletionParams) => void, refuseControls = false) {
	const seen: ChatCompletionParams[] = []
	const provider: LLMProvider = {
		id: 'fake',
		name: 'fake',
		async *chatStream(params) {
			seen.push(params)
			onRequest(params)
			if (refuseControls && (params.thinking || params.effort))
				throw new Error('This model does not accept the reasoning effort field.')
			yield { id: '1', delta: { content: 'ok' }, finishReason: 'stop' } as StreamChunk
		},
	}
	return { provider, seen }
}

describe('chatStreamForSideRequest', () => {
	it('sends the reasoning-off fields and never the turn effort', async () => {
		const { provider, seen } = fake(() => {})
		const base = { model: 'm', messages: [], maxTokens: 60 }
		for await (const _ of chatStreamForSideRequest(provider, base)) void _
		expect(seen).toHaveLength(1)
		expect(seen[0]?.thinking).toEqual({ type: 'disabled' })
		expect(seen[0]?.maxTokens).toBe(60 + SIDE_REQUEST_REASONING_HEADROOM)
	})

	it('resends once without the controls when the driver refuses them, then remembers', async () => {
		const { provider, seen } = fake(() => {}, true)
		const base = { model: 'm', messages: [], maxTokens: 60 }
		for await (const _ of chatStreamForSideRequest(provider, base)) void _
		expect(seen).toHaveLength(2)
		expect(seen[1]?.thinking).toBeUndefined()
		expect(seen[1]?.maxTokens).toBe(60 + SIDE_REQUEST_REASONING_HEADROOM)
		for await (const _ of chatStreamForSideRequest(provider, base)) void _
		expect(seen).toHaveLength(3)
		expect(seen[2]?.thinking).toBeUndefined()
	})

	it('does not retry a failure that is not about the controls', async () => {
		const provider: LLMProvider = {
			id: 'f',
			name: 'f',
			// biome-ignore lint/correctness/useYield: fails before any output
			async *chatStream() {
				throw new Error('socket hang up')
			},
		}
		const run = async () => {
			for await (const _ of chatStreamForSideRequest(provider, { model: 'm', messages: [] })) void _
		}
		await expect(run()).rejects.toThrow('socket hang up')
	})
})
