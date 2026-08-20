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
import {
	appendMessages,
	loadConversation,
	openSessions,
	startConversation,
} from '../../integrations/sessions/store.js'
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

function toolStreamResponse(): Response {
	const chunks = [
		{
			id: 'chatcmpl-tool',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-v4-flash',
			choices: [
				{ index: 0, delta: { reasoning_content: 'TOOL_REASONING_EXACT' }, finish_reason: null },
			],
		},
		{
			id: 'chatcmpl-tool',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-v4-flash',
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: 'call_glob_exact',
								type: 'function',
								function: { name: 'glob', arguments: '{"pattern":"NO_MATCH_REPLAY_*"}' },
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			id: 'chatcmpl-tool',
			object: 'chat.completion.chunk',
			created: 1,
			model: 'deepseek-v4-flash',
			choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
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
		source: {
			type: 'model',
			providerId: 'deepseek',
			model: 'deepseek-v4-flash',
			chainIndex: 0,
			replayState: {
				kind: 'namzu-deepseek-reasoning',
				version: 1,
				reasoningContent: 'REASONING_1',
			},
		},
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

it('replays a persisted reasoning tool turn after rebuilding the same route', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-deepseek-reasoning-resume-'))
	roots.push(cwd)
	const requestBodies: Array<{ messages?: Record<string, unknown>[] }> = []
	const network = vi.fn<typeof fetch>(async (_input, init) => {
		requestBodies.push(JSON.parse(String(init?.body)) as { messages?: Record<string, unknown>[] })
		return requestBodies.length === 1 ? toolStreamResponse() : streamResponse(requestBodies.length)
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
	const firstSession = await createAgentSession(preferences, detected, { cwd })
	let produced: readonly Message[] | undefined
	try {
		for await (const _event of firstSession.send([createUserMessage('use a tool')], {
			onConversationMessages: (messages) => {
				produced = messages
			},
		})) {
			// drain the tool turn and its automatic continuation
		}
	} finally {
		await firstSession.close()
	}
	if (!produced) throw new Error('the first session did not publish its conversation')

	const sessions = await openSessions(cwd)
	const conversationId = await startConversation(sessions)
	await appendMessages(sessions, conversationId, produced)
	const loaded = await loadConversation(sessions, conversationId)
	const nativeTurn = loaded.find(
		(message) => message.role === 'assistant' && (message.toolCalls?.length ?? 0) > 0,
	)
	expect(nativeTurn).toMatchObject({
		role: 'assistant',
		reasoning: [{ type: 'thinking', text: 'TOOL_REASONING_EXACT' }],
		toolCalls: [{ id: 'call_glob_exact', function: { name: 'glob' } }],
		source: {
			type: 'model',
			providerId: 'deepseek',
			model: 'deepseek-v4-flash',
			chainIndex: 0,
			replayState: {
				kind: 'namzu-deepseek-reasoning',
				version: 1,
				reasoningContent: 'TOOL_REASONING_EXACT',
			},
		},
	})

	const resumedSession = await createAgentSession(preferences, detected, { cwd })
	try {
		for await (const _event of resumedSession.send([
			...loaded,
			createUserMessage('continue after restart'),
		])) {
			// drain the reconstructed session
		}
	} finally {
		await resumedSession.close()
	}

	const switchedSession = await createAgentSession(
		{ ...preferences, providers: [{ id: 'deepseek', model: 'deepseek-v4-pro' }] },
		detected,
		{ cwd },
	)
	try {
		for await (const _event of switchedSession.send([
			...loaded,
			createUserMessage('continue on another model'),
		])) {
			// drain the model-switched session
		}
	} finally {
		await switchedSession.close()
	}

	expect(requestBodies).toHaveLength(4)
	const resumedMessages = requestBodies[2]?.messages ?? []
	const assistantIndex = resumedMessages.findIndex(
		(message) =>
			message.role === 'assistant' && message.reasoning_content === 'TOOL_REASONING_EXACT',
	)
	const resultIndex = resumedMessages.findIndex(
		(message) => message.role === 'tool' && message.tool_call_id === 'call_glob_exact',
	)
	expect(assistantIndex).toBeGreaterThanOrEqual(0)
	expect(resultIndex).toBeGreaterThan(assistantIndex)
	expect(resumedMessages[assistantIndex]).toMatchObject({
		role: 'assistant',
		reasoning_content: 'TOOL_REASONING_EXACT',
		tool_calls: [{ id: 'call_glob_exact', function: { name: 'glob' } }],
	})
	const switchedAssistant = requestBodies[3]?.messages?.find(
		(message) => message.role === 'assistant' && message.content === null,
	)
	expect(switchedAssistant).toMatchObject({
		role: 'assistant',
		tool_calls: [{ id: 'call_glob_exact', function: { name: 'glob' } }],
	})
	expect(switchedAssistant).not.toHaveProperty('reasoning_content')
})
