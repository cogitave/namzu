import { describe, expect, it } from 'vitest'

import { LMSTUDIO_CAPABILITIES, LMStudioProvider } from '../client.js'

/**
 * A pasted picture reaches a loaded LM Studio model that reads pictures, as a
 * file handle the SDK prepared from the base64 bytes and attached to the chat
 * message, and only that one. The SDK's client is replaced by a recorder; no
 * LM Studio runs here.
 */

const PNG = 'iVBORw0KGgo='

function provider(vision: boolean | undefined) {
	const prepared: { name: string; data: string }[] = []
	const chats: { role: string; content: string; images?: unknown[] }[][] = []
	const prediction = {
		async *[Symbol.asyncIterator]() {
			yield { content: 'ok' }
		},
		// biome-ignore lint/suspicious/noThenProperty: the SDK's prediction is both iterable and awaitable
		then: (resolve: (value: unknown) => void) =>
			resolve({ stats: { stopReason: 'eosFound', promptTokensCount: 1, predictedTokensCount: 1 } }),
	}
	const p = new LMStudioProvider({ model: 'local-model' })
	;(p as unknown as { clientInstance: unknown }).clientInstance = {
		files: {
			prepareImageBase64: async (name: string, data: string) => {
				prepared.push({ name, data })
				return { identifier: `handle-${prepared.length}`, name }
			},
		},
		llm: {
			model: async () => ({
				...(vision === undefined ? {} : { vision }),
				respond: (chat: { role: string; content: string; images?: unknown[] }[]) => {
					chats.push(chat)
					return prediction
				},
			}),
			listLoaded: async () => [
				{ identifier: 'listed-vision', vision: true },
				{ identifier: 'listed-text', vision: false },
			],
		},
	}
	return { p, prepared, chats }
}

async function ask(p: LMStudioProvider, messages: unknown[]) {
	for await (const _chunk of p.chatStream({ model: 'local-model', messages } as never)) {
		// drain
	}
}

const withPicture = {
	role: 'user' as const,
	content: 'what is on it',
	attachments: [{ data: PNG, mediaType: 'image/png' }],
}

describe('LM Studio: pictures', () => {
	it('declares that it maps pictures', () => {
		expect(LMSTUDIO_CAPABILITIES.supportsVision).toBe(true)
		expect(LMSTUDIO_CAPABILITIES.supportsToolResultImages).toBe(true)
	})

	it('attaches a prepared file handle for a vision model', async () => {
		const { p, prepared, chats } = provider(true)
		await ask(p, [withPicture])
		expect(prepared).toEqual([{ name: 'image-1.png', data: PNG }])
		expect(chats[0]).toEqual([
			{
				role: 'user',
				content: 'what is on it',
				images: [{ identifier: 'handle-1', name: 'image-1.png' }],
			},
		])
	})

	it('leaves the picture out, with a note, for a model the SDK says is not vision-enabled', async () => {
		const { p, prepared, chats } = provider(false)
		await ask(p, [withPicture])
		expect(prepared).toEqual([])
		expect(chats[0]?.[0]?.images).toBeUndefined()
		expect(chats[0]?.[0]?.content).toContain('[image omitted: the current model cannot read images')
		expect(p.supportsImageInputFor('local-model')).toBe(false)
	})

	it('sends the picture to a model whose vision flag the SDK does not give', async () => {
		const { p, prepared } = provider(undefined)
		await ask(p, [withPicture])
		expect(prepared).toHaveLength(1)
		expect(p.supportsImageInputFor('local-model')).toBe(true)
	})

	it('knows a vision flag from the loaded-model listing, with no chat request', async () => {
		const { p } = provider(true)
		expect(p.supportsImageInputFor('listed-text')).toBe(true) // not looked at yet
		await p.listModels()
		expect(p.supportsImageInputFor('listed-text')).toBe(false)
		expect(p.supportsImageInputFor('listed-vision')).toBe(true)
	})

	it('never prepares a file for a request with no picture', async () => {
		const { p, prepared, chats } = provider(true)
		await ask(p, [{ role: 'user', content: 'hello' }])
		expect(prepared).toEqual([])
		expect(chats[0]).toEqual([{ role: 'user', content: 'hello' }])
	})

	it('keeps a withheld picture out', async () => {
		const { p, prepared } = provider(true)
		await ask(p, [
			{
				...withPicture,
				attachments: [
					{ data: PNG, mediaType: 'image/png', modelOmission: { reason: 'invalid-image' } },
				],
			},
		])
		expect(prepared).toEqual([])
	})

	it('attaches a tool result picture to the folded tool message for a vision model', async () => {
		const { p, prepared, chats } = provider(true)
		await ask(p, [
			{ role: 'user', content: 'look' },
			{
				role: 'tool',
				toolCallId: 'call_1',
				content: [
					{ type: 'text', text: 'screenshot taken' },
					{ type: 'image', data: PNG, mediaType: 'image/jpeg' },
				],
			},
		])
		expect(prepared).toEqual([{ name: 'image-1.jpg', data: PNG }])
		const tool = chats[0]?.[1]
		expect(tool?.role).toBe('user')
		expect(tool?.images).toHaveLength(1)
		expect(tool?.content).toContain('[tool-result] screenshot taken')
		expect(tool?.content).not.toContain('not renderable')
	})

	it('names a tool result picture as left out for a text-only model', async () => {
		const { p, prepared, chats } = provider(false)
		await ask(p, [
			{ role: 'user', content: 'look' },
			{
				role: 'tool',
				toolCallId: 'c',
				content: [{ type: 'image', data: PNG, mediaType: 'image/png' }],
			},
		])
		expect(prepared).toEqual([])
		expect(chats[0]?.[1]?.content).toContain('[image omitted: the current model cannot read images')
	})
})
