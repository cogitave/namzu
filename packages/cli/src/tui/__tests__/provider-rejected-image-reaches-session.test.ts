/** A real provider rejection heals the CLI's durable conversation without losing bytes. */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, createUserMessage } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { type AgentEvent, createAgentSession } from '../agent.js'

const roots: string[] = []

afterEach(() => {
	vi.unstubAllGlobals()
	for (const root of roots.splice(0)) removeTempDir(root)
})

function streamResponse(turn: number): Response {
	const chunks = [
		{
			id: `chatcmpl-${turn}`,
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-v4-flash-vision-exp',
			choices: [{ index: 0, delta: { content: `answer ${turn}` }, finish_reason: null }],
		},
		{
			id: `chatcmpl-${turn}`,
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-v4-flash-vision-exp',
			choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
			usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
		},
	]
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

it('surfaces and persists one server-confirmed image omission before continuing', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-image-rejection-session-'))
	roots.push(cwd)
	const imageData = 'aW52YWxpZC1pbWFnZQ=='
	const requestBodies: Array<{ messages?: Record<string, unknown>[] }> = []
	const network = vi.fn<typeof fetch>(async (_input, init) => {
		requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Record<string, unknown>[] })
		if (requestBodies.length === 1) {
			return new Response(
				JSON.stringify({
					error: {
						message: 'some future wording without the legacy phrase',
						type: 'invalid_request_error',
						code: 'invalid_image',
					},
				}),
				{ status: 400, headers: { 'content-type': 'application/json' } },
			)
		}
		return streamResponse(requestBodies.length)
	})
	vi.stubGlobal('fetch', network)
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'deepseek', model: 'deepseek-v4-flash-vision-exp' }],
		subagents: { active: [] },
	}
	const detected = [
		{
			entry: PROVIDER_REGISTRY.deepseek,
			source: { kind: 'env', envName: 'DEEPSEEK_API_KEY' },
			apiKey: 'not-a-real-key',
			alternatives: [],
		} as DetectedProvider,
	]
	const session = await createAgentSession(preferences, detected, { cwd })
	const events: AgentEvent[] = []
	let conversation: readonly Message[] | undefined

	try {
		for await (const event of session.send(
			[createUserMessage('inspect', [{ data: imageData, mediaType: 'image/png' }])],
			{
				onConversationMessages: (messages) => {
					conversation = messages
				},
			},
		)) {
			events.push(event)
		}
		if (!conversation) throw new Error('the healed conversation was not published')

		for await (const _event of session.send([
			...conversation,
			createUserMessage('continue without resending the rejected bytes'),
		])) {
			// drain the reconstructed turn
		}
	} finally {
		await session.close()
	}

	expect(requestBodies).toHaveLength(3)
	expect(JSON.stringify(requestBodies[0])).toContain(imageData)
	expect(JSON.stringify(requestBodies[1])).not.toContain(imageData)
	expect(JSON.stringify(requestBodies[1])).toContain('provider rejected this image')
	expect(JSON.stringify(requestBodies[2])).not.toContain(imageData)
	const durable = JSON.stringify(conversation)
	expect(durable).toContain(imageData)
	expect(durable).toContain('provider-rejected')
	const warningIndex = events.findIndex(
		(event) => event.kind === 'history-repair' && event.source === 'provider-rejected-image',
	)
	const deltaIndex = events.findIndex((event) => event.kind === 'delta')
	expect(warningIndex).toBeGreaterThanOrEqual(0)
	expect(warningIndex).toBeLessThan(deltaIndex)
	expect(events[warningIndex]).toMatchObject({
		kind: 'history-repair',
		source: 'provider-rejected-image',
	})
	expect(
		events[warningIndex]?.kind === 'history-repair' ? events[warningIndex].text : '',
	).toContain('original attachment bytes were kept')
})
