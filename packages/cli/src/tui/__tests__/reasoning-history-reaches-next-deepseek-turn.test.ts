/** A real DeepSeek session replays a prior plain answer's reasoning next turn. */

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
import { createAgentSession } from '../agent.js'

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
			model: 'deepseek-v4-flash',
			choices: [
				{ index: 0, delta: { reasoning_content: `REASONING_${turn}` }, finish_reason: null },
			],
		},
		{
			id: `chatcmpl-${turn}`,
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-v4-flash',
			choices: [{ index: 0, delta: { content: `answer ${turn}` }, finish_reason: null }],
		},
		{
			id: `chatcmpl-${turn}`,
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-v4-flash',
			choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
			usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
		},
	]
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')}data: [DONE]\n\n`
	return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

it('keeps fresh system floor private and sends exact prior reasoning_content', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-deepseek-reasoning-history-'))
	roots.push(cwd)
	const requestBodies: Array<{ messages?: Record<string, unknown>[] }> = []
	const network = vi.fn<typeof fetch>(async (_input, init) => {
		requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Record<string, unknown>[] })
		return streamResponse(requestBodies.length)
	})
	vi.stubGlobal('fetch', network)
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'deepseek' }],
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
	let firstConversation: readonly Message[] | undefined

	try {
		for await (const _event of session.send([createUserMessage('first question')], {
			extraSystem: 'FIRST_TURN_ONLY_DYNAMIC_CONTEXT',
			onConversationMessages: (messages) => {
				firstConversation = messages
			},
		})) {
			// drain the real session
		}
		if (!firstConversation) throw new Error('the settled conversation callback was not reached')

		for await (const _event of session.send(
			[...firstConversation, createUserMessage('second question')],
			{ extraSystem: 'SECOND_TURN_ONLY_DYNAMIC_CONTEXT' },
		)) {
			// drain the second real session
		}
	} finally {
		await session.close()
	}

	expect(firstConversation).toHaveLength(2)
	expect(firstConversation?.some((message) => message.role === 'system')).toBe(false)
	expect(firstConversation?.[1]).toMatchObject({
		role: 'assistant',
		content: 'answer 1',
		reasoning: [{ type: 'thinking', text: 'REASONING_1' }],
	})
	expect(requestBodies).toHaveLength(2)
	const secondBody = requestBodies[1]
	const priorAssistant = secondBody?.messages?.find(
		(message) => message.role === 'assistant' && message.content === 'answer 1',
	)
	expect(priorAssistant).toMatchObject({ reasoning_content: 'REASONING_1' })
	const secondWire = JSON.stringify(secondBody)
	expect(secondWire).toContain('SECOND_TURN_ONLY_DYNAMIC_CONTEXT')
	expect(secondWire).not.toContain('FIRST_TURN_ONLY_DYNAMIC_CONTEXT')
})
