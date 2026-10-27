import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { Message } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { placeRequestContext, stepContextMessage } from '../iteration/step-context.js'

/**
 * The request-only data a turn carries goes last on every call, after the
 * whole history, so that each request begins with the history of the one before
 * it and a caching provider, which ends its breakpoint before the first such
 * block, keeps reading the same prefix whatever the blocks say.
 */

registerMock()

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : ''

function setup() {
	const tools = testToolset({
		name: 'look',
		description: 'Look at something',
		inputSchema: z.object({ what: z.string() }),
		execute: async () => ({ success: true, output: 'seen' }),
	})
	return {
		toolsets: [tools],
		agentId: 'a',
		agentName: 'A',
		systemPrompt: 'You are a coding agent.',
		workingDirectory: process.cwd(),
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 6 },
		compactionConfig: CompactionConfigSchema.parse({}),
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	}
}

const twoCalls = () =>
	new MockLLMProvider({
		turns: [
			{ toolCalls: [{ id: 'c1', name: 'look', args: { what: 'x' } }] },
			{ toolCalls: [{ id: 'c2', name: 'look', args: { what: 'y' } }] },
			{ text: 'done' },
		],
	})

describe('per-turn request context across the calls of one turn', () => {
	it('begins each later request with the whole of the one before it', async () => {
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'snapshot', placement: 'context', render: () => 'SNAPSHOT TEXT' })
		const provider = twoCalls()
		await drainQuery({
			...setup(),
			provider,
			promptContributions: contributions,
			prepareStep: () => ({ context: 'EVIDENCE TEXT' }),
			messages: [
				{ role: 'user', content: 'earlier question' },
				{ role: 'assistant', content: 'earlier answer' },
				{ role: 'user', content: 'the new request' },
			],
		})

		expect(provider.requests).toHaveLength(3)
		const requestOnly = (m: Message) =>
			m.role === 'user' && m.source?.type === 'runtime-context' && m.source.kind === 'step-context'
		const shape = (messages: readonly Message[]) => messages.map((m) => `${m.role}:${text(m)}`)
		const history = (messages: readonly Message[]) => shape(messages.filter((m) => !requestOnly(m)))
		for (const [i, request] of provider.requests.entries()) {
			const messages = request.messages as Message[]
			// Every request-only block is after the last history message.
			const lastHistory = messages
				.map((m) => !requestOnly(m) && m.role !== 'system')
				.lastIndexOf(true)
			const firstBlock = messages.findIndex(requestOnly)
			expect(firstBlock).toBeGreaterThan(lastHistory)
			expect(messages.slice(firstBlock).every((m) => requestOnly(m) || m.role === 'system')).toBe(
				true,
			)
			if (i === 0) continue
			// The history of a request begins with the whole history of the one before.
			const before = history(provider.requests[i - 1]?.messages as Message[])
			expect(history(messages).slice(0, before.length)).toEqual(before)
		}

		// The data follows the person's message on the first request.
		const first = provider.requests[0]?.messages as Message[]
		const asked = first.findIndex((m) => text(m) === 'the new request')
		expect(asked).toBeGreaterThan(0)
		expect(first.findIndex((m) => text(m).includes('SNAPSHOT TEXT'))).toBeGreaterThan(asked)
		expect(first.findIndex((m) => text(m).includes('EVIDENCE TEXT'))).toBeGreaterThan(asked)
	})

	it('sends an unchanged block once per request, not again after the history', async () => {
		const provider = twoCalls()
		await drainQuery({
			...setup(),
			provider,
			prepareStep: () => ({ context: 'EVIDENCE TEXT' }),
			messages: [{ role: 'user', content: 'go' }],
		})
		for (const request of provider.requests) {
			const copies = (request.messages as Message[]).filter((m) =>
				text(m).includes('EVIDENCE TEXT'),
			)
			expect(copies).toHaveLength(1)
		}
	})

	it('withdraws a block whose text changed and places the new text after the history', async () => {
		const provider = twoCalls()
		await drainQuery({
			...setup(),
			provider,
			prepareStep: ({ stepNumber }) => ({ context: `FACT VERSION ${stepNumber}` }),
			messages: [{ role: 'user', content: 'go' }],
		})
		const second = provider.requests[1]?.messages as Message[]
		expect(second.some((m) => text(m).includes('FACT VERSION 1'))).toBe(false)
		const at = second.findIndex((m) => text(m).includes('FACT VERSION 2'))
		expect(at).toBeGreaterThan(second.findIndex((m) => m.role === 'tool'))
	})
})

describe('placeRequestContext', () => {
	const user = (content: string): Message => ({ role: 'user', content })
	const assistant = (content: string): Message => ({ role: 'assistant', content })
	const block = (content: string) => stepContextMessage(content)

	it('puts the blocks after the whole history, in the order offered, each text once', () => {
		const request = [user('ask'), assistant('reply')]
		placeRequestContext(request, [], 0, [block('A'), block('B'), block('A')])
		expect(request.map(text)).toEqual([
			'ask',
			'reply',
			expect.stringContaining('A'),
			expect.stringContaining('B'),
		])
	})

	it('puts entries just recorded ahead of the request-only blocks already at the end', () => {
		const pinned = block('PINNED')
		const request = [user('ask'), assistant('reply'), pinned]
		placeRequestContext(request, [user('RECORDED')], 1, [block('RUNNING')])
		expect(request.map(text)).toEqual([
			'ask',
			'reply',
			'RECORDED',
			expect.stringContaining('PINNED'),
			expect.stringContaining('RUNNING'),
		])
	})

	it('leaves the history alone when there are no recorded entries and no tail', () => {
		const request = [user('ask')]
		placeRequestContext(request, [], 0, [])
		expect(request.map(text)).toEqual(['ask'])
	})
})
