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
import { TurnContextCarry, stepContextMessage } from '../iteration/step-context.js'

/**
 * The data a turn carries (project memory, conversation evidence, the
 * repository snapshot, file evidence) goes before the person's message the
 * first time the model answers it. Every later call of the turn must keep it
 * there, so that the request begins with the whole of the one before it and a
 * caching provider keeps reading the same prefix; data that changed is
 * withdrawn and the new text follows the history of that moment.
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
		const shape = (messages: readonly Message[]) => messages.map((m) => `${m.role}:${text(m)}`)
		for (const [i, request] of provider.requests.entries()) {
			if (i === 0) continue
			const before = shape(provider.requests[i - 1]?.messages as Message[])
			expect(shape(request.messages as Message[]).slice(0, before.length)).toEqual(before)
		}

		// And the person's message is still the edge of the first request.
		const first = provider.requests[0]?.messages as Message[]
		const last = first.at(-1) as Message
		expect(text(last)).toBe('the new request')
		expect(first.some((m) => text(m).includes('SNAPSHOT TEXT'))).toBe(true)
		expect(first.some((m) => text(m).includes('EVIDENCE TEXT'))).toBe(true)
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

	it('keeps project memory in place when only the evidence block after it changes', async () => {
		const provider = twoCalls()
		await drainQuery({
			...setup(),
			provider,
			prepareStep: ({ stepNumber }) => ({
				context: `MEMORY TEXT\n\nRetrieved conversation evidence: version ${stepNumber}\n{}`,
			}),
			messages: [{ role: 'user', content: 'go' }],
		})
		const shape = (messages: readonly Message[]) => messages.map((m) => `${m.role}:${text(m)}`)
		const first = shape(provider.requests[0]?.messages as Message[])
		const second = shape(provider.requests[1]?.messages as Message[])
		const memoryAt = first.findIndex((line) => line.includes('MEMORY TEXT'))
		expect(memoryAt).toBeGreaterThanOrEqual(0)
		expect(second.slice(0, memoryAt + 1)).toEqual(first.slice(0, memoryAt + 1))
		expect(second.some((line) => line.includes('version 1'))).toBe(false)
		expect(second.some((line) => line.includes('version 2'))).toBe(true)
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

describe('TurnContextCarry', () => {
	const user = (content: string): Message => ({ role: 'user', content })
	const assistant = (content: string): Message => ({ role: 'assistant', content })
	const block = (content: string) => stepContextMessage(content)

	it('keeps a block where it first went and drops one that is no longer offered', () => {
		const carry = new TurnContextCarry()
		const ask = user('ask')
		const first = [ask]
		const one = [...first]
		carry.place(one, first, ask, [block('A'), block('B')])
		expect(one.map(text)).toEqual([
			expect.stringContaining('A'),
			expect.stringContaining('B'),
			'ask',
		])

		const reply = assistant('reply')
		const second = [ask, reply]
		const two = [...second]
		carry.place(two, second, reply, [block('A')])
		expect(two.map(text)).toEqual([expect.stringContaining('A'), 'ask', 'reply'])
	})

	it('follows the history for a block that first appears after the operator was answered', () => {
		const carry = new TurnContextCarry()
		const ask = user('ask')
		const reply = assistant('reply')
		const history = [ask, reply]
		const request = [...history]
		carry.place(request, history, reply, [block('LATE')])
		expect(request.map(text)).toEqual(['ask', 'reply', expect.stringContaining('LATE')])
	})

	it('gives up a position whose message left the history', () => {
		const carry = new TurnContextCarry()
		const ask = user('ask')
		carry.place([ask], [ask], ask, [block('A')])
		const summary = assistant('summary')
		const history = [summary]
		const request = [...history]
		carry.place(request, history, summary, [block('A')])
		expect(request.map(text)).toEqual(['summary', expect.stringContaining('A')])
	})

	it('keeps an earlier version of a replaceable block as sent and appends the later one', () => {
		const carry = new TurnContextCarry()
		const ask = user('ask')
		const one = [ask]
		carry.place(one, [ask], ask, [], [{ key: 'files', message: block('FILES v1') }])
		expect(one.map(text)).toEqual([expect.stringContaining('FILES v1'), 'ask'])

		const reply = assistant('reply')
		const history = [ask, reply]
		const two = [...history]
		carry.place(two, history, reply, [], [{ key: 'files', message: block('FILES v2') }])
		expect(two.map(text)).toEqual([
			expect.stringContaining('FILES v1'),
			'ask',
			'reply',
			expect.stringContaining('FILES v2'),
		])
		// And the request after that begins with all of this one.
		const more = assistant('more')
		const longer = [ask, reply, more]
		const three = [...longer]
		carry.place(three, longer, more, [], [{ key: 'files', message: block('FILES v2') }])
		expect(three.map(text).slice(0, 4)).toEqual(two.map(text))
	})

	it('says so, once, when a replaceable block stops holding', () => {
		const carry = new TurnContextCarry()
		const ask = user('ask')
		const gone = { files: block('NOTHING HOLDS') }
		carry.place([ask], [ask], ask, [], [{ key: 'files', message: block('FILES v1') }], gone)
		const reply = assistant('reply')
		const history = [ask, reply]
		const two = [...history]
		carry.place(two, history, reply, [], [], gone)
		expect(two.map(text)).toEqual([
			expect.stringContaining('FILES v1'),
			'ask',
			'reply',
			expect.stringContaining('NOTHING HOLDS'),
		])
		const three = [...history]
		carry.place(three, history, reply, [], [], gone)
		expect(three.map(text)).toEqual(two.map(text))
	})
})
