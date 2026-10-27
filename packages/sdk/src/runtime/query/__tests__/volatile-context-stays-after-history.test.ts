import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CompactionConfigSchema } from '../../../config/runtime.js'
import { PromptContributionRegistry } from '../../../prompt/contributions.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import type { Message } from '../../../types/message/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { WORKING_MEMORY_HEADER } from '../iteration/phases/working-memory.js'

/**
 * Kernel observations that change from request to request ride the
 * request-only context channel, never the system run.
 *
 * A driver may hoist every system message ahead of the conversation —
 * some render tools, then system, then messages — so a system message
 * whose text changes invalidates the cached conversation prefix, and the
 * whole history is re-read at full price. The working-memory slot changes
 * whenever a pin does; a `context` contribution changes whenever the host's
 * observation does. Both must reach the request after the history, as
 * runtime-context messages of kind `step-context`, which every driver keeps
 * there and a caching driver ends its breakpoint before.
 *
 * The blocks that belong to the turn (what a `context` contribution renders)
 * go after the history of the moment they first appear, never ahead of the
 * operator's message. A block the step offers again with the same text keeps
 * that place on every later call of the turn. What a step wants kept across
 * turns is recorded instead (`recordedContext`).
 */

registerMock()

function isRequestOnly(message: Message): boolean {
	return (
		message.role === 'user' &&
		message.source?.type === 'runtime-context' &&
		message.source.kind === 'step-context'
	)
}

const text = (message: Message): string =>
	typeof message.content === 'string' ? message.content : ''

/** Every step-context message opens with this line; the slot follows it. */
const LABEL = 'Current step context (runtime-generated; not a new user request):\n'
const isSlot = (t: string): boolean => t.startsWith(`${LABEL}${WORKING_MEMORY_HEADER}`)

/**
 * The request-only context after the history: the trailing run of
 * `step-context` messages, looking past the trailing system guidance a step
 * may add between the history and them.
 */
function trailingContext(messages: readonly Message[]): Message[] {
	let end = messages.length
	while (end > 0) {
		const message = messages[end - 1]
		if (!message || !(isRequestOnly(message) || message.role === 'system')) break
		end--
	}
	return messages.slice(end).filter(isRequestOnly)
}

function setup() {
	const tools = testToolset({
		name: 'note',
		description: 'Pin a fact',
		inputSchema: z.object({ text: z.string() }),
		execute: async ({ text }) => ({
			success: true,
			output: 'noted',
			workingState: [{ key: `k${++n}`, text }],
		}),
	})
	let n = 0
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

describe('the working-memory slot in a request', () => {
	it('is request-only context after the history, not a system message', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'note', args: { text: 'FIRST_FACT' } }] },
				{ toolCalls: [{ id: 'c2', name: 'note', args: { text: 'SECOND_FACT' } }] },
				{ text: 'done' },
			],
		})
		const events: SessionEvent[] = []
		const result = await drainQuery(
			{ ...setup(), provider, messages: [{ role: 'user', content: 'pin things' }] },
			(event) => {
				events.push(event)
			},
		)

		for (const request of provider.requests.slice(1)) {
			const messages = request.messages as Message[]
			const system = messages.filter((m) => m.role === 'system').map(text)
			expect(system.join('\n')).not.toContain(WORKING_MEMORY_HEADER)
			// Labelled like every other step-context message, so the model
			// does not read the slot as something the operator just said.
			const slot = trailingContext(messages).filter((m) => isSlot(text(m)))
			expect(slot).toHaveLength(1)
		}
		const second = provider.requests[2]?.messages as Message[]
		expect(trailingContext(second).map(text).join('\n')).toContain('SECOND_FACT')

		// Two requests whose pins differ share the whole system run: the
		// change lives only in the request-only tail.
		const systemOf = (i: number) =>
			(provider.requests[i]?.messages as Message[]).filter((m) => m.role === 'system').map(text)
		expect(systemOf(2)).toEqual(systemOf(1))

		// The envelope reports what the model is asked as system text, so the
		// slot is no longer part of it.
		for (const event of events) {
			if (event.type === 'request_envelope') {
				expect(event.systemPrompt).not.toContain(WORKING_MEMORY_HEADER)
			}
		}

		// The turn's own history still keeps the slot where compaction
		// preserves it: in the leading system run.
		const history = (result as { messages?: Message[] }).messages ?? []
		const lead: Message[] = []
		for (const message of history) {
			if (message.role !== 'system') break
			lead.push(message)
		}
		expect(lead.map(text).some((t) => t.startsWith(WORKING_MEMORY_HEADER))).toBe(true)
		expect(history.some(isRequestOnly)).toBe(false)
	})
})

describe('a context contribution', () => {
	it('renders per iteration into request-only context after the history of that moment', async () => {
		const contributions = new PromptContributionRegistry()
		contributions.register({
			id: 'observation',
			placement: 'context',
			render: ({ iteration }) => `OBSERVED AT ${iteration}`,
		})
		contributions.register({
			id: 'rare',
			placement: 'context',
			render: ({ iteration }) => (iteration === 2 ? 'ONLY ON TWO' : null),
		})
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'note', args: { text: 'FACT' } }] },
				{ toolCalls: [{ id: 'c2', name: 'note', args: { text: 'FACT TWO' } }] },
				{ text: 'done' },
			],
		})
		const result = await drainQuery({
			...setup(),
			provider,
			promptContributions: contributions,
			messages: [{ role: 'user', content: 'go' }],
		})

		expect(provider.requests).toHaveLength(3)
		for (const [i, request] of provider.requests.entries()) {
			const messages = request.messages as Message[]
			const system = messages
				.filter((m) => m.role === 'system')
				.map(text)
				.join('\n')
			expect(system).not.toContain('OBSERVED AT')
			const placed = trailingContext(messages).map(text).join('\n')
			expect(placed).toContain(`OBSERVED AT ${i + 1}`)
			expect(placed.includes('ONLY ON TWO')).toBe(i === 1)
			// Once per request, never twice.
			expect(messages.map(text).join('\n').split('OBSERVED AT').length - 1).toBe(1)
		}

		// Request-only: never pushed onto the turn's history.
		const history = (result as { messages?: Message[] }).messages ?? []
		expect(history.map(text).join('\n')).not.toContain('OBSERVED AT')
	})

	it('comes after the working-memory slot once a tool has run, and leaves turn contributions in the system run', async () => {
		const contributions = new PromptContributionRegistry()
		contributions.register({ id: 'obs', placement: 'context', render: () => 'CONTEXT TEXT' })
		contributions.register({ id: 'turnly', placement: 'turn', render: () => 'TURN TEXT' })
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'note', args: { text: 'FACT' } }] },
				{ text: 'done' },
			],
		})
		await drainQuery({
			...setup(),
			provider,
			promptContributions: contributions,
			messages: [{ role: 'user', content: 'go' }],
		})

		// The first request has only the operator's message to answer: the context follows it.
		const first = provider.requests[0]?.messages as Message[]
		const userAt = first.findIndex((m) => m.role === 'user' && m.source === undefined)
		expect(first.findIndex((m) => text(m).includes('CONTEXT TEXT'))).toBeGreaterThan(userAt)

		const messages = provider.requests[1]?.messages as Message[]
		const tail = trailingContext(messages).map(text)
		const slotAt = tail.findIndex(isSlot)
		const contextAt = tail.findIndex((t) => t.includes('CONTEXT TEXT'))
		expect(slotAt).toBeGreaterThanOrEqual(0)
		// The context text first appeared right after the operator's message and
		// stays there, ahead of the trailing slot, so it is not in the trailing run.
		expect(contextAt).toBe(-1)
		const placedAt = messages.findIndex((m) => text(m).includes('CONTEXT TEXT'))
		expect(placedAt).toBeGreaterThanOrEqual(0)
		expect(placedAt).toBeGreaterThan(
			messages.findIndex((m) => m.role === 'user' && m.source === undefined),
		)
		// `turn` keeps its documented system authority.
		expect(
			messages
				.filter((m) => m.role === 'system')
				.map(text)
				.join('\n'),
		).toContain('TURN TEXT')
	})
})

describe('recalled context from preparation', () => {
	it('sits right after the operator message while the reminders after it stay last', async () => {
		const provider = new MockLLMProvider({
			turns: [
				{ toolCalls: [{ id: 'c1', name: 'note', args: { text: 'FACT' } }] },
				{ text: 'done' },
			],
		})
		await drainQuery({
			...setup(),
			provider,
			prepareStep: () => ({ context: 'RECALLED MEMORY BODY' }),
			messages: [
				{ role: 'user', content: 'earlier question' },
				{ role: 'assistant', content: 'earlier answer' },
				{ role: 'user', content: 'the new request' },
			],
		})

		const [request] = provider.requests
		{
			const messages = request!.messages as Message[]
			const userAt = messages.findIndex((m) => m.role === 'user' && text(m) === 'the new request')
			const recalled = messages.findIndex((m) => text(m).includes('RECALLED MEMORY BODY'))
			expect(userAt).toBeGreaterThan(0)
			expect(recalled).toBeGreaterThanOrEqual(0)
			expect(recalled).toBe(userAt + 1)
			// Once per request, and the earlier question is not displaced.
			expect(messages.filter((m) => text(m).includes('RECALLED MEMORY BODY'))).toHaveLength(1)
			expect(messages.findIndex((m) => text(m) === 'earlier question')).toBeLessThan(recalled)
		}

		// After the tool call the same block keeps its place after the operator's
		// message, and the second request begins with the whole of the first.
		const later = provider.requests[1]?.messages as Message[]
		const indexOfLast = (predicate: (m: Message) => boolean) => {
			for (let i = later.length - 1; i >= 0; i--) if (predicate(later[i] as Message)) return i
			return -1
		}
		const lastRecalled = indexOfLast((m) => text(m).includes('RECALLED MEMORY BODY'))
		const lastUser = indexOfLast((m) => m.role === 'user' && m.source === undefined)
		expect(lastRecalled).toBe(lastUser + 1)
		const firstMessages = request!.messages as Message[]
		// Everything the first request held before its trailing notices is still
		// at the head of the second, so a cached prefix keeps reading.
		const conversation = (messages: readonly Message[]) =>
			messages.filter((m) => m.role !== 'system')
		const stable = conversation(firstMessages)
		expect(conversation(later).slice(0, stable.length).map(text)).toEqual(stable.map(text))
	})
})
