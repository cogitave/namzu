import type { StreamChunk } from '@namzu/sdk'
import { expect, it, vi } from 'vitest'
import { GoogleProvider } from '../client.js'

it('combines native search and functions and retains grounded links', async () => {
	const response = {
		candidates: [
			{
				content: { parts: [{ text: 'A grounded answer.' }] },
				finishReason: 'STOP',
				groundingMetadata: {
					webSearchQueries: ['test'],
					groundingChunks: [{ web: { uri: 'https://example.com/source', title: 'Source' } }],
				},
			},
		],
	}
	const fetch = vi.fn<typeof globalThis.fetch>(
		async () => new Response(`data: ${JSON.stringify(response)}\n\n`),
	)
	const provider = new GoogleProvider({ apiKey: 'fixture', fetch })
	const chunks: StreamChunk[] = []
	for await (const c of provider.chatStream({
		model: 'gemini-3-flash-preview',
		messages: [{ role: 'user', content: 'Search' }],
		webSearch: { mode: 'live' },
		tools: [
			{
				type: 'function',
				function: {
					name: 'read',
					description: 'Read a file',
					parameters: { type: 'object', properties: {} },
				},
			},
		],
	}))
		chunks.push(c)
	const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))
	expect(body.tools).toContainEqual({ googleSearch: {} })
	expect(body.tools[0].functionDeclarations[0].name).toBe('read')
	expect(chunks.map((c) => c.delta.content ?? '').join('')).toContain('https://example.com/source')
	expect(chunks.flatMap((c) => (c.delta.hostedTool ? [c.delta.hostedTool.status] : []))).toEqual([
		'running',
		'completed',
	])
	const content = chunks.map((c) => c.delta.content ?? '').join('')
	const replayState = chunks.find((c) => c.replayState)?.replayState
	for await (const _ of provider.chatStream({
		model: 'gemini-3-flash-preview',
		messages: [
			{
				role: 'assistant',
				content,
				source: {
					type: 'model',
					providerId: 'google',
					model: 'gemini-3-flash-preview',
					chainIndex: 0,
					replayState,
				},
			},
			{ role: 'user', content: 'Which source was that?' },
		],
	})) {
	}
	const resumed = JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))
	expect(JSON.stringify(resumed.contents[0].parts)).toContain('https://example.com/source')
	expect(provider.supportsHostedWebSearchFor('gemini-2.5-flash', 'live')).toBe(false)
	expect(provider.supportsHostedWebSearchFor('gemini-3-flash-preview', 'cached')).toBe(false)
	expect(
		new GoogleProvider({
			getAccessToken: async () => 'fixture',
		}).supportsHostedWebSearchFor('gemini-3-flash-preview', 'live'),
	).toBe(false)
})
